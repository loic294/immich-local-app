//! Operation progress through ISM's Server-Sent Events stream, with a polling fallback.

use super::operations::OperationItemView;
use super::*;
use reqwest::header::{ACCEPT, CACHE_CONTROL};
use tokio::time::Instant;

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const KNOWN_TERMINAL: [&str; 5] = [
    "completed",
    "partial",
    "failed",
    "cancelled",
    "recovery_required",
];

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct SseEvent {
    pub id: Option<String>,
    pub event: String,
    pub data: String,
}

/// Incremental `text/event-stream` parser; feed it raw chunks and collect complete events.
#[derive(Default)]
pub(super) struct SseParser {
    buffer: String,
    pending: Vec<u8>,
    current: SseEvent,
    has_field: bool,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.pending.extend_from_slice(chunk);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(text) => text.len(),
            Err(error) => error.valid_up_to(),
        };
        let text = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
        self.pending.drain(..valid);
        self.buffer.push_str(&text);
        let mut events = Vec::new();
        while let Some(end) = self.buffer.find('\n') {
            let mut line: String = self.buffer.drain(..=end).collect();
            line.pop();
            if line.ends_with('\r') {
                line.pop();
            }
            if line.is_empty() {
                if self.has_field {
                    let mut event = std::mem::take(&mut self.current);
                    if event.event.is_empty() {
                        event.event = "message".into();
                    }
                    events.push(event);
                    self.has_field = false;
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
                None => (line.as_str(), ""),
            };
            match field {
                "id" => self.current.id = Some(value.to_string()),
                "event" => self.current.event = value.to_string(),
                "data" => {
                    if !self.current.data.is_empty() {
                        self.current.data.push('\n');
                    }
                    self.current.data.push_str(value);
                }
                _ => continue,
            }
            self.has_field = true;
        }
        events
    }
}

fn check_terminal(view: &OperationView) -> Result<(), String> {
    if view.is_pending() || KNOWN_TERMINAL.contains(&view.status.as_str()) {
        Ok(())
    } else {
        Err(format!(
            "ISM operation has an unknown status: {}",
            view.status
        ))
    }
}

enum Stream {
    Finished,
    Ended,
    Unavailable,
}

impl IsmClient {
    fn operation_url(&self, operation_id: &str, events: bool) -> Result<Url, String> {
        let mut url = self.endpoint("api/v1/operations/")?;
        {
            let mut segments = url.path_segments_mut().map_err(|_| "Invalid ISM URL")?;
            segments.pop_if_empty().push(operation_id);
            if events {
                segments.push("events");
            }
        }
        Ok(url)
    }

    /// Waits until the operation is terminal or `timeout` elapses (then it is returned pending).
    /// Progress follows the SSE stream, reconnecting with `Last-Event-ID`; when the stream is not
    /// available the status is polled instead.
    pub async fn wait_operation_view(
        &self,
        operation_id: &str,
        timeout: Duration,
    ) -> Result<OperationView, String> {
        let deadline = Instant::now() + timeout;
        let mut view = self.operation_view(operation_id).await?;
        check_terminal(&view)?;
        let mut last_event_id = None;
        let mut stream_available = true;
        while view.is_pending() && Instant::now() < deadline {
            if stream_available {
                match self
                    .follow_events(operation_id, &mut view, &mut last_event_id, deadline)
                    .await?
                {
                    Stream::Finished => break,
                    Stream::Ended => {
                        // A closed stream may mean the operation finished between events.
                        view = self.operation_view(operation_id).await?;
                    }
                    Stream::Unavailable => {
                        log::info!(
                            "[ism:events] stream unavailable for operation={operation_id}; polling"
                        );
                        stream_available = false
                    }
                }
            } else {
                let remaining = deadline.saturating_duration_since(Instant::now());
                tokio::time::sleep(POLL_INTERVAL.min(remaining)).await;
                view = self.operation_view(operation_id).await?;
            }
            check_terminal(&view)?;
        }
        Ok(view)
    }

    async fn follow_events(
        &self,
        operation_id: &str,
        view: &mut OperationView,
        last_event_id: &mut Option<String>,
        deadline: Instant,
    ) -> Result<Stream, String> {
        let mut request = self
            .client
            .get(self.operation_url(operation_id, true)?)
            .header(AUTHORIZATION, self.authorization.clone())
            .header(ACCEPT, "text/event-stream")
            .header(CACHE_CONTROL, "no-cache");
        if let Some(id) = last_event_id.as_deref() {
            request = request.header("Last-Event-ID", id);
        }
        let response = match tokio::time::timeout_at(deadline, request.send()).await {
            Err(_) => return Ok(Stream::Ended),
            Ok(Err(_)) => return Ok(Stream::Unavailable),
            Ok(Ok(response)) => response,
        };
        let is_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        if !response.status().is_success() || !is_stream {
            return Ok(Stream::Unavailable);
        }
        let mut response = response;
        let mut parser = SseParser::default();
        loop {
            let chunk = match tokio::time::timeout_at(deadline, response.chunk()).await {
                Err(_) | Ok(Ok(None)) | Ok(Err(_)) => return Ok(Stream::Ended),
                Ok(Ok(Some(chunk))) => chunk,
            };
            for event in parser.push(&chunk) {
                if let Some(id) = event.id.filter(|id| !id.is_empty()) {
                    *last_event_id = Some(id);
                }
                match event.event.as_str() {
                    "progress" | "finished" => {
                        let next: OperationView = serde_json::from_str(&event.data)
                            .map_err(|_| "Invalid ISM operation event".to_string())?;
                        if next.operation_id != operation_id {
                            return Err("ISM operation event is for another operation".into());
                        }
                        *view = next;
                    }
                    "item" => {
                        let item: OperationItemView = serde_json::from_str(&event.data)
                            .map_err(|_| "Invalid ISM operation item event".to_string())?;
                        match view
                            .items
                            .iter_mut()
                            .find(|known| known.index == item.index)
                        {
                            Some(known) => *known = item,
                            None => view.items.push(item),
                        }
                    }
                    "resync" => {
                        *view = self.operation_view(operation_id).await?;
                    }
                    _ => {}
                }
                check_terminal(view)?;
                if !view.is_pending() {
                    return Ok(Stream::Finished);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::server;
    use super::*;

    fn op(status: &str, item_status: &str) -> String {
        serde_json::json!({
            "operation_id": "op_1", "status": status,
            "items": [{ "index": 0, "kind": "move", "status": item_status, "error": null, "result": null }]
        })
        .to_string()
    }

    fn sse(body: &str) -> Vec<u8> {
        body.as_bytes().to_vec()
    }

    #[test]
    fn parser_handles_split_chunks_comments_and_multiline_data() {
        let mut parser = SseParser::default();
        assert!(parser.push(b": keep-alive\n\nid: 4\nevent: ite").is_empty());
        let events =
            parser.push(b"m\r\ndata: {\"a\":\ndata: 1}\r\n\r\nevent: resync\ndata: {}\n\n");
        assert_eq!(
            events,
            vec![
                SseEvent {
                    id: Some("4".into()),
                    event: "item".into(),
                    data: "{\"a\":\n1}".into()
                },
                SseEvent {
                    id: None,
                    event: "resync".into(),
                    data: "{}".into()
                }
            ]
        );
    }

    #[tokio::test]
    async fn stream_progress_reconnects_with_last_event_id_and_resyncs() {
        let first = format!(
            "id: 1\nevent: progress\ndata: {}\n\nid: 2\nevent: item\ndata: {}\n\n",
            op("running", "pending"),
            r#"{"index":0,"kind":"move","status":"done","error":null,"result":{"asset_id":"asset-1"}}"#
        );
        let (url, requests) = server(vec![
            ("200 OK", op("queued", "pending").into_bytes()),
            ("200 OK\r\nContent-Type: text/event-stream", sse(&first)),
            ("200 OK", op("running", "done").into_bytes()),
            (
                "200 OK\r\nContent-Type: text/event-stream",
                sse("event: resync\ndata: {}\n\n"),
            ),
            ("200 OK", op("completed", "done").into_bytes()),
        ])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        let view = client
            .wait_operation_view("op_1", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(view.status, "completed");
        let requests = requests.await.unwrap();
        assert!(requests[1].starts_with("GET /api/v1/operations/op_1/events"));
        assert!(requests[1].contains("accept: text/event-stream"));
        assert!(!requests[1].to_ascii_lowercase().contains("last-event-id"));
        assert!(requests[3].contains("last-event-id: 2"));
        assert!(requests[4].starts_with("GET /api/v1/operations/op_1 "));
    }

    #[tokio::test]
    async fn finished_event_ends_the_wait_and_missing_stream_falls_back_to_polling() {
        let finished = format!(
            "id: 3\nevent: finished\ndata: {}\n\n",
            op("completed", "done")
        );
        let (url, requests) = server(vec![
            ("200 OK", op("running", "pending").into_bytes()),
            ("200 OK\r\nContent-Type: text/event-stream", sse(&finished)),
        ])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        let view = client
            .wait_operation_view("op_1", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(view.status, "completed");
        assert_eq!(requests.await.unwrap().len(), 2);

        let (url, requests) = server(vec![
            ("200 OK", op("running", "pending").into_bytes()),
            ("404 Not Found", b"{}".to_vec()),
            ("200 OK", op("failed", "failed").into_bytes()),
        ])
        .await;
        let client = IsmClient::new(&url, "token").unwrap();
        let view = client
            .wait_operation_view("op_1", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(view.status, "failed");
        let requests = requests.await.unwrap();
        assert!(requests[2].starts_with("GET /api/v1/operations/op_1 "));
    }
}
