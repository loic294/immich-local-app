//! Native menu bar for macOS and Windows.
//!
//! Rust owns the menu *structure*; the frontend (`src/shortcuts/appMenu.ts`) drives its
//! *content*. It pushes localized labels, accelerators and enabled state by item id through
//! `update_app_menu`, and receives clicks as `app-menu-action` events that carry the item id.
//! Standard system items (clipboard, window and app commands) keep their native behavior; only
//! their text is localized. The same goes for Help > Activity Log, which Rust handles itself by
//! opening the Activity Log window.
//!
//! The menu is attached with `Builder::menu` instead of `App::set_menu` from `setup`: on Windows
//! a menu bar added after the window exists shrinks its client area, and `window_state` persists
//! that size.

use serde::Deserialize;

/// One menu update from the frontend, matched to a native item by `id`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub struct MenuEntry {
    pub id: String,
    pub label: String,
    /// Action items only. `None` clears the accelerator.
    #[serde(default)]
    pub accelerator: Option<String>,
    /// Action items only. `None` keeps the current state.
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// Registers the native menu and its click handler on the application builder.
pub fn install(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    platform::install(builder)
}

/// Applies localized labels, accelerators and enabled state to the native menu.
///
/// A synchronous command, so it runs on the main thread and menu mutations apply inline.
#[tauri::command]
pub fn update_app_menu(app: tauri::AppHandle, entries: Vec<MenuEntry>) -> Result<(), String> {
    platform::update(&app, &entries)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
use native as platform;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use unsupported as platform;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported {
    use super::MenuEntry;
    use tauri::{AppHandle, Builder, Wry};

    pub fn install(builder: Builder<Wry>) -> Builder<Wry> {
        builder
    }

    pub fn update(_app: &AppHandle, _entries: &[MenuEntry]) -> Result<(), String> {
        Err(
            "unsupported_platform: the native menu bar is only available on macOS and Windows"
                .to_string(),
        )
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native {
    use super::MenuEntry;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;
    use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::{AppHandle, Builder, Emitter, Manager, Wry};

    /// Event sent to the frontend when an action item is chosen. The payload is the item id.
    const MENU_ACTION_EVENT: &str = "app-menu-action";
    const PLATFORM: &str = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "windows"
    };

    /// Items that trigger a frontend shortcut action. Must match `MENU_ACTION_IDS` in
    /// `src/shortcuts/appMenu.ts`.
    const ACTION_IDS: &[&str] = &[
        "photo.favorite",
        "photo.delete",
        "photo.addToAlbum",
        "album.create",
        "nav.albums",
        "photo.share",
        "photo.copyToClipboard",
        "photo.showInFolder",
        "photo.copyToFolder",
        "nav.settings",
    ];

    /// Submenu titles. Must match `MENU_SUBMENU_IDS` in `src/shortcuts/appMenu.ts`.
    const SUBMENU_IDS: &[&str] = &[
        "menu.photos",
        "menu.albums",
        "menu.share",
        "menu.edit",
        "menu.view",
        "menu.window",
        "menu.help",
    ];

    /// The Help item that opens the Activity Log window. It is listed in `SYSTEM_IDS`.
    const ACTIVITY_LOG_ID: &str = "system.activityLog";

    /// Items with localized text only: the standard system items, plus the Activity Log item.
    /// Must match `MENU_SYSTEM_IDS` in `src/shortcuts/appMenu.ts`.
    const SYSTEM_IDS: &[&str] = &[
        "system.about",
        "system.services",
        "system.hide",
        "system.hideOthers",
        "system.showAll",
        "system.quit",
        "system.undo",
        "system.redo",
        "system.cut",
        "system.copy",
        "system.paste",
        "system.selectAll",
        "system.fullscreen",
        "system.minimize",
        "system.zoom",
        "system.closeWindow",
        "system.activityLog",
    ];

    const ACCELERATOR_MODIFIERS: &[&str] = &["cmdorctrl", "ctrl", "alt", "shift", "cmd", "super"];
    const ACCELERATOR_NAMED_KEYS: &[&str] = &[
        "backspace",
        "delete",
        "end",
        "home",
        "insert",
        "pageup",
        "pagedown",
        "enter",
        "space",
        "tab",
        "escape",
        "esc",
        "arrowup",
        "arrowdown",
        "arrowleft",
        "arrowright",
    ];
    const ACCELERATOR_PUNCTUATION: &str = "`\\[],=-.';/";

    fn is_action_id(id: &str) -> bool {
        ACTION_IDS.contains(&id)
    }

    fn is_known_id(id: &str) -> bool {
        is_action_id(id) || SUBMENU_IDS.contains(&id) || SYSTEM_IDS.contains(&id)
    }

    /// Whether a click on this item should reach the main window as a shortcut action. The menu
    /// bar is shared by every window on macOS, so while the Activity Log window is active its
    /// keystrokes must not act on the photos selected in the main window.
    fn forwards_to_main_window(id: &str, activity_log_focused: bool) -> bool {
        is_action_id(id) && !activity_log_focused
    }

    fn is_function_key(key: &str) -> bool {
        key.strip_prefix('f').is_some_and(|number| {
            !number.starts_with('0')
                && number.chars().all(|digit| digit.is_ascii_digit())
                && number.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n))
        })
    }

    fn is_supported_key(key: &str) -> bool {
        let key = key.to_ascii_lowercase();
        if ACCELERATOR_NAMED_KEYS.contains(&key.as_str()) || is_function_key(&key) {
            return true;
        }
        let mut chars = key.chars();
        match (chars.next(), chars.next()) {
            (Some(single), None) => {
                single.is_ascii_alphanumeric() || ACCELERATOR_PUNCTUATION.contains(single)
            }
            _ => false,
        }
    }

    /// The accelerator grammar the frontend emits: `+`-separated modifiers followed by exactly
    /// one key. Tauri silently drops an accelerator it cannot parse, so checking up front lets a
    /// bad one be reported instead of vanishing. A repeated modifier is rejected too, although
    /// Tauri tolerates it, because it can only come from a frontend bug.
    fn is_supported_accelerator(accelerator: &str) -> bool {
        let mut tokens: Vec<&str> = accelerator.split('+').collect();
        let Some(key) = tokens.pop() else {
            return false;
        };
        let mut seen = HashSet::new();
        let modifiers_valid = tokens.iter().all(|token| {
            let modifier = token.to_ascii_lowercase();
            ACCELERATOR_MODIFIERS.contains(&modifier.as_str()) && seen.insert(modifier)
        });
        modifiers_valid && is_supported_key(key)
    }

    /// What the menu currently shows for one item.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct ItemState {
        label: String,
        accelerator: Option<String>,
        enabled: bool,
    }

    /// The fields of an item that must change to reach a new state.
    #[derive(Debug, Default, PartialEq, Eq)]
    struct ItemChange {
        label: Option<String>,
        /// `Some(None)` clears the accelerator.
        accelerator: Option<Option<String>>,
        enabled: Option<bool>,
    }

    impl ItemChange {
        fn is_empty(&self) -> bool {
            self.label.is_none() && self.accelerator.is_none() && self.enabled.is_none()
        }
    }

    fn diff_item(previous: &ItemState, next: &ItemState) -> ItemChange {
        ItemChange {
            label: (previous.label != next.label).then(|| next.label.clone()),
            accelerator: (previous.accelerator != next.accelerator)
                .then(|| next.accelerator.clone()),
            enabled: (previous.enabled != next.enabled).then_some(next.enabled),
        }
    }

    /// The outcome of comparing a batch of entries with what the menu currently shows.
    #[derive(Debug, Default)]
    struct Plan {
        changes: Vec<(&'static str, ItemChange)>,
        problems: Vec<String>,
        unchanged: usize,
        /// Contract ids that this platform's menu does not have, such as the macOS-only items.
        skipped: usize,
    }

    fn plan_update(applied: &HashMap<&'static str, ItemState>, entries: &[MenuEntry]) -> Plan {
        let mut plan = Plan::default();
        for entry in entries {
            if !is_known_id(&entry.id) {
                plan.problems
                    .push(format!("unknown menu id {:?}", entry.id));
                continue;
            }
            let Some((&id, previous)) = applied.get_key_value(entry.id.as_str()) else {
                plan.skipped += 1;
                continue;
            };
            if entry.label.trim().is_empty() {
                plan.problems.push(format!("{id}: empty label"));
                continue;
            }

            let mut next = previous.clone();
            next.label = entry.label.clone();
            if is_action_id(id) {
                next.accelerator = match entry.accelerator.as_deref() {
                    Some(accelerator) if !is_supported_accelerator(accelerator) => {
                        plan.problems
                            .push(format!("{id}: unsupported accelerator {accelerator:?}"));
                        None
                    }
                    accelerator => accelerator.map(str::to_owned),
                };
                if let Some(enabled) = entry.enabled {
                    next.enabled = enabled;
                }
            }

            let change = diff_item(previous, &next);
            if change.is_empty() {
                plan.unchanged += 1;
            } else {
                plan.changes.push((id, change));
            }
        }
        plan
    }

    /// A native menu object that can be updated after the menu is built.
    enum MenuHandle {
        Item(MenuItem<Wry>),
        Predefined(PredefinedMenuItem<Wry>),
        Submenu(Submenu<Wry>),
    }

    impl MenuHandle {
        fn set_text(&self, text: &str) -> tauri::Result<()> {
            match self {
                Self::Item(item) => item.set_text(text),
                Self::Predefined(item) => item.set_text(text),
                Self::Submenu(submenu) => submenu.set_text(text),
            }
        }

        fn set_accelerator(&self, accelerator: Option<&str>) -> tauri::Result<()> {
            match self {
                Self::Item(item) => item.set_accelerator(accelerator),
                Self::Predefined(_) | Self::Submenu(_) => Ok(()),
            }
        }

        fn set_enabled(&self, enabled: bool) -> tauri::Result<()> {
            match self {
                Self::Item(item) => item.set_enabled(enabled),
                Self::Predefined(_) | Self::Submenu(_) => Ok(()),
            }
        }
    }

    /// Every item the frontend can address, with what it currently shows. Built together with
    /// the menu so each item starts out in a known state.
    #[derive(Default)]
    struct Registry {
        handles: HashMap<&'static str, MenuHandle>,
        applied: HashMap<&'static str, ItemState>,
        synced: bool,
    }

    impl Registry {
        fn track(&mut self, id: &'static str, handle: MenuHandle, label: &str, enabled: bool) {
            self.handles.insert(id, handle);
            self.applied.insert(
                id,
                ItemState {
                    label: label.to_owned(),
                    accelerator: None,
                    enabled,
                },
            );
        }

        /// An item that triggers a frontend action. It stays disabled until the frontend reports
        /// that the action applies to the current view.
        fn action(
            &mut self,
            app: &AppHandle,
            id: &'static str,
            label: &str,
        ) -> tauri::Result<MenuItem<Wry>> {
            let item = MenuItem::with_id(app, id, label, false, None::<&str>)?;
            self.track(id, MenuHandle::Item(item.clone()), label, false);
            Ok(item)
        }

        /// An item that Rust handles itself. It is always enabled and has no accelerator, so the
        /// frontend only supplies its text.
        fn command(
            &mut self,
            app: &AppHandle,
            id: &'static str,
            label: &str,
        ) -> tauri::Result<MenuItem<Wry>> {
            let item = MenuItem::with_id(app, id, label, true, None::<&str>)?;
            self.track(id, MenuHandle::Item(item.clone()), label, true);
            Ok(item)
        }

        /// A native system item, created with the same text it is tracked under.
        #[cfg(target_os = "macos")]
        fn system(
            &mut self,
            id: &'static str,
            label: &str,
            create: impl FnOnce(Option<&str>) -> tauri::Result<PredefinedMenuItem<Wry>>,
        ) -> tauri::Result<PredefinedMenuItem<Wry>> {
            let item = create(Some(label))?;
            self.track(id, MenuHandle::Predefined(item.clone()), label, true);
            Ok(item)
        }

        fn submenu(
            &mut self,
            app: &AppHandle,
            id: &'static str,
            label: &str,
            items: &[&dyn IsMenuItem<Wry>],
        ) -> tauri::Result<Submenu<Wry>> {
            let submenu = Submenu::with_items(app, label, true, items)?;
            self.track(id, MenuHandle::Submenu(submenu.clone()), label, true);
            Ok(submenu)
        }
    }

    struct AppMenuState(Mutex<Registry>);

    /// The Photos, Albums and Share menus, shared by both platforms. Labels are English
    /// placeholders until the frontend sends the localized ones.
    fn content_submenus(
        app: &AppHandle,
        registry: &mut Registry,
    ) -> tauri::Result<[Submenu<Wry>; 3]> {
        let favorite = registry.action(app, "photo.favorite", "Favorite")?;
        let delete = registry.action(app, "photo.delete", "Delete")?;
        let photos = registry.submenu(app, "menu.photos", "Photos", &[&favorite, &delete])?;

        let add_to_album = registry.action(app, "photo.addToAlbum", "Add to album")?;
        let create_album = registry.action(app, "album.create", "Create new album")?;
        let view_albums = registry.action(app, "nav.albums", "View albums")?;
        let albums = registry.submenu(
            app,
            "menu.albums",
            "Albums",
            &[
                &add_to_album,
                &create_album,
                &PredefinedMenuItem::separator(app)?,
                &view_albums,
            ],
        )?;

        let share_link = registry.action(app, "photo.share", "Share with a link")?;
        let copy_images =
            registry.action(app, "photo.copyToClipboard", "Copy images to clipboard")?;
        let show_in_folder = registry.action(app, "photo.showInFolder", "Open in File Explorer")?;
        let copy_to_folder =
            registry.action(app, "photo.copyToFolder", "Copy to USB stick/folder")?;
        let share = registry.submenu(
            app,
            "menu.share",
            "Share",
            &[
                &share_link,
                &PredefinedMenuItem::separator(app)?,
                &copy_images,
                &show_in_folder,
                &copy_to_folder,
            ],
        )?;

        Ok([photos, albums, share])
    }

    /// The Help menu, shared by both platforms. Its only item opens the Activity Log window, so
    /// it works whatever the main window is showing.
    fn help_submenu(app: &AppHandle, registry: &mut Registry) -> tauri::Result<Submenu<Wry>> {
        let activity_log = registry.command(app, ACTIVITY_LOG_ID, "Activity Log")?;
        registry.submenu(app, "menu.help", "Help", &[&activity_log])
    }

    /// Windows shows Photos, Albums and Share, then Help.
    #[cfg(target_os = "windows")]
    fn build_menu(app: &AppHandle, registry: &mut Registry) -> tauri::Result<Menu<Wry>> {
        let [photos, albums, share] = content_submenus(app, registry)?;
        let help = help_submenu(app, registry)?;
        Menu::with_items(app, &[&photos, &albums, &share, &help])
    }

    /// macOS needs the application menu first, and the Edit menu so the clipboard and undo keys
    /// keep working in text fields, plus the standard View and Window menus.
    #[cfg(target_os = "macos")]
    fn build_menu(app: &AppHandle, registry: &mut Registry) -> tauri::Result<Menu<Wry>> {
        use tauri::menu::AboutMetadata;

        let package = app.package_info();
        let name = package.name.clone();
        let config = app.config();
        let about = AboutMetadata {
            name: Some(name.clone()),
            version: Some(package.version.to_string()),
            copyright: config.bundle.copyright.clone(),
            authors: config
                .bundle
                .publisher
                .clone()
                .map(|publisher| vec![publisher]),
            ..Default::default()
        };

        let about_item = registry.system("system.about", &format!("About {name}"), |text| {
            PredefinedMenuItem::about(app, text, Some(about))
        })?;
        let settings = registry.action(app, "nav.settings", "Settings…")?;
        let services = registry.system("system.services", "Services", |text| {
            PredefinedMenuItem::services(app, text)
        })?;
        let hide = registry.system("system.hide", &format!("Hide {name}"), |text| {
            PredefinedMenuItem::hide(app, text)
        })?;
        let hide_others = registry.system("system.hideOthers", "Hide Others", |text| {
            PredefinedMenuItem::hide_others(app, text)
        })?;
        let show_all = registry.system("system.showAll", "Show All", |text| {
            PredefinedMenuItem::show_all(app, text)
        })?;
        let quit = registry.system("system.quit", &format!("Quit {name}"), |text| {
            PredefinedMenuItem::quit(app, text)
        })?;
        let app_menu = Submenu::with_items(
            app,
            &name,
            true,
            &[
                &about_item,
                &PredefinedMenuItem::separator(app)?,
                &settings,
                &PredefinedMenuItem::separator(app)?,
                &services,
                &PredefinedMenuItem::separator(app)?,
                &hide,
                &hide_others,
                &show_all,
                &PredefinedMenuItem::separator(app)?,
                &quit,
            ],
        )?;

        let [photos, albums, share] = content_submenus(app, registry)?;

        let undo = registry.system("system.undo", "Undo", |text| {
            PredefinedMenuItem::undo(app, text)
        })?;
        let redo = registry.system("system.redo", "Redo", |text| {
            PredefinedMenuItem::redo(app, text)
        })?;
        let cut = registry.system("system.cut", "Cut", |text| {
            PredefinedMenuItem::cut(app, text)
        })?;
        let copy = registry.system("system.copy", "Copy", |text| {
            PredefinedMenuItem::copy(app, text)
        })?;
        let paste = registry.system("system.paste", "Paste", |text| {
            PredefinedMenuItem::paste(app, text)
        })?;
        let select_all = registry.system("system.selectAll", "Select All", |text| {
            PredefinedMenuItem::select_all(app, text)
        })?;
        let edit = registry.submenu(
            app,
            "menu.edit",
            "Edit",
            &[
                &undo,
                &redo,
                &PredefinedMenuItem::separator(app)?,
                &cut,
                &copy,
                &paste,
                &select_all,
            ],
        )?;

        let fullscreen = registry.system("system.fullscreen", "Toggle Full Screen", |text| {
            PredefinedMenuItem::fullscreen(app, text)
        })?;
        let view = registry.submenu(app, "menu.view", "View", &[&fullscreen])?;

        let minimize = registry.system("system.minimize", "Minimize", |text| {
            PredefinedMenuItem::minimize(app, text)
        })?;
        let zoom = registry.system("system.zoom", "Zoom", |text| {
            PredefinedMenuItem::maximize(app, text)
        })?;
        let close_window = registry.system("system.closeWindow", "Close Window", |text| {
            PredefinedMenuItem::close_window(app, text)
        })?;
        let window = registry.submenu(
            app,
            "menu.window",
            "Window",
            &[
                &minimize,
                &zoom,
                &PredefinedMenuItem::separator(app)?,
                &close_window,
            ],
        )?;
        window.set_as_windows_menu_for_nsapp()?;

        let help = help_submenu(app, registry)?;
        help.set_as_help_menu_for_nsapp()?;

        Menu::with_items(
            app,
            &[
                &app_menu, &photos, &albums, &share, &edit, &view, &window, &help,
            ],
        )
    }

    fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
        let mut registry = Registry::default();
        let menu = build_menu(app, &mut registry)?;
        app.manage(AppMenuState(Mutex::new(registry)));
        Ok(menu)
    }

    /// Action items reach the frontend and the Activity Log item opens its window; the other
    /// system items keep their native behavior. Never takes the menu state lock: a menu event can
    /// arrive while an update holds it.
    fn on_menu_event(app: &AppHandle, event: MenuEvent) {
        let id: &str = event.id().as_ref();
        if id == ACTIVITY_LOG_ID {
            log::info!("[menu] item activated id={id}");
            crate::activity_window::open_in_background(app);
            return;
        }
        if !is_action_id(id) {
            return;
        }
        if !forwards_to_main_window(id, crate::activity_window::is_focused()) {
            log::info!("[menu] ignored id={id}: the Activity Log window is active");
            return;
        }
        log::info!("[menu] item activated id={id}");
        if let Err(error) = app.emit(MENU_ACTION_EVENT, id) {
            log::error!("[menu] could not deliver {MENU_ACTION_EVENT} id={id}: {error}");
        }
    }

    pub fn install(builder: Builder<Wry>) -> Builder<Wry> {
        builder.menu(build).on_menu_event(on_menu_event)
    }

    fn apply_change(
        registry: &mut Registry,
        id: &'static str,
        change: &ItemChange,
        problems: &mut Vec<String>,
    ) {
        let Registry {
            handles, applied, ..
        } = registry;
        let (Some(handle), Some(state)) = (handles.get(id), applied.get_mut(id)) else {
            problems.push(format!("{id}: item is not part of this menu"));
            return;
        };

        if let Some(label) = &change.label {
            match handle.set_text(label) {
                Ok(()) => state.label = label.clone(),
                Err(error) => problems.push(format!("{id}: could not set the label: {error}")),
            }
        }
        if let Some(accelerator) = &change.accelerator {
            match handle.set_accelerator(accelerator.as_deref()) {
                Ok(()) => state.accelerator = accelerator.clone(),
                Err(error) => {
                    problems.push(format!("{id}: could not set the accelerator: {error}"))
                }
            }
        }
        if let Some(enabled) = change.enabled {
            match handle.set_enabled(enabled) {
                Ok(()) => state.enabled = enabled,
                Err(error) => {
                    problems.push(format!("{id}: could not set the enabled state: {error}"))
                }
            }
        }
    }

    pub fn update(app: &AppHandle, entries: &[MenuEntry]) -> Result<(), String> {
        let state = app.try_state::<AppMenuState>().ok_or_else(|| {
            "menu_unavailable: the native menu has not been initialized".to_string()
        })?;
        let mut registry = state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let plan = plan_update(&registry.applied, entries);
        let mut problems = plan.problems;
        for (id, change) in &plan.changes {
            apply_change(&mut registry, id, change, &mut problems);
        }

        if !problems.is_empty() {
            log::warn!(
                "[menu] update finished with {} problem(s): {}",
                problems.len(),
                problems.join("; ")
            );
            return Err(format!("menu update failed: {}", problems.join("; ")));
        }

        if !registry.synced {
            registry.synced = true;
            log::info!(
                "[menu] native menu ready platform={PLATFORM} items={} applied={} skipped={}",
                registry.applied.len(),
                plan.changes.len(),
                plan.skipped
            );
        } else {
            log::debug!(
                "[menu] update applied={} unchanged={} skipped={}",
                plan.changes.len(),
                plan.unchanged,
                plan.skipped
            );
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn state(label: &str, accelerator: Option<&str>, enabled: bool) -> ItemState {
            ItemState {
                label: label.to_owned(),
                accelerator: accelerator.map(str::to_owned),
                enabled,
            }
        }

        fn entry(
            id: &str,
            label: &str,
            accelerator: Option<&str>,
            enabled: Option<bool>,
        ) -> MenuEntry {
            MenuEntry {
                id: id.to_owned(),
                label: label.to_owned(),
                accelerator: accelerator.map(str::to_owned),
                enabled,
            }
        }

        fn applied() -> HashMap<&'static str, ItemState> {
            HashMap::from([
                ("photo.favorite", state("Favorite", None, false)),
                (
                    "photo.delete",
                    state("Delete", Some("CmdOrCtrl+Backspace"), true),
                ),
                ("menu.photos", state("Photos", None, true)),
            ])
        }

        #[test]
        fn contract_ids_are_unique_across_every_list() {
            let mut seen = HashSet::new();
            for id in ACTION_IDS.iter().chain(SUBMENU_IDS).chain(SYSTEM_IDS) {
                assert!(seen.insert(*id), "duplicate menu id {id}");
            }
        }

        #[test]
        fn recognizes_contract_ids_only() {
            assert!(is_action_id("photo.favorite"));
            assert!(!is_action_id("system.copy"));
            assert!(!is_action_id("menu.photos"));
            assert!(is_known_id("menu.photos"));
            assert!(is_known_id("system.copy"));
            assert!(!is_known_id("photo.unknown"));
        }

        #[test]
        fn the_activity_log_item_is_a_text_only_item_in_the_help_menu() {
            assert!(SYSTEM_IDS.contains(&ACTIVITY_LOG_ID));
            assert!(SUBMENU_IDS.contains(&"menu.help"));
            assert!(is_known_id(ACTIVITY_LOG_ID));
            assert!(!is_action_id(ACTIVITY_LOG_ID));

            let applied = HashMap::from([(ACTIVITY_LOG_ID, state("Activity Log", None, true))]);
            let plan = plan_update(
                &applied,
                &[entry(
                    ACTIVITY_LOG_ID,
                    "Journal d’activité",
                    Some("CmdOrCtrl+L"),
                    Some(false),
                )],
            );
            assert!(plan.problems.is_empty(), "{:?}", plan.problems);
            assert_eq!(
                plan.changes,
                vec![(
                    ACTIVITY_LOG_ID,
                    ItemChange {
                        label: Some("Journal d’activité".to_owned()),
                        ..ItemChange::default()
                    }
                )],
                "only the text changes: it stays enabled and takes no accelerator"
            );
        }

        #[test]
        fn shortcuts_stay_with_the_main_window_while_the_activity_log_is_active() {
            for id in ACTION_IDS {
                assert!(forwards_to_main_window(id, false), "{id}");
                assert!(!forwards_to_main_window(id, true), "{id}");
            }
            for id in ["system.copy", ACTIVITY_LOG_ID, "menu.help", "photo.unknown"] {
                assert!(!forwards_to_main_window(id, false), "{id}");
            }
        }

        #[test]
        fn accepts_the_accelerators_the_frontend_emits() {
            for accelerator in [
                "CmdOrCtrl+Shift+A",
                "CmdOrCtrl+Backspace",
                "CmdOrCtrl+,",
                "CmdOrCtrl+-",
                "CmdOrCtrl+=",
                "CmdOrCtrl+1",
                "CmdOrCtrl+Ctrl+Alt+Shift+ArrowLeft",
                "Alt+Escape",
                "Delete",
                "F12",
            ] {
                assert!(is_supported_accelerator(accelerator), "{accelerator}");
            }
        }

        #[test]
        fn rejects_malformed_accelerators() {
            for accelerator in [
                "",
                "CmdOrCtrl+",
                "+A",
                "CmdOrCtrl+Shift",
                "A+B",
                "Hyper+A",
                "CmdOrCtrl+Foo",
                "CmdOrCtrl+CmdOrCtrl+A",
                "F0",
                "F01",
                "F25",
            ] {
                assert!(!is_supported_accelerator(accelerator), "{accelerator:?}");
            }
        }

        #[test]
        fn diff_reports_only_the_fields_that_differ() {
            let previous = state("Favorite", None, false);
            assert!(diff_item(&previous, &previous).is_empty());

            let next = state("Favorite", Some("CmdOrCtrl+D"), false);
            assert_eq!(
                diff_item(&previous, &next),
                ItemChange {
                    label: None,
                    accelerator: Some(Some("CmdOrCtrl+D".to_owned())),
                    enabled: None,
                }
            );
            assert_eq!(
                diff_item(&next, &previous).accelerator,
                Some(None),
                "dropping a shortcut clears the native accelerator"
            );
        }

        #[test]
        fn plans_changes_for_action_items() {
            let plan = plan_update(
                &applied(),
                &[entry(
                    "photo.favorite",
                    "Favori",
                    Some("CmdOrCtrl+D"),
                    Some(true),
                )],
            );
            assert!(plan.problems.is_empty());
            assert_eq!(
                plan.changes,
                vec![(
                    "photo.favorite",
                    ItemChange {
                        label: Some("Favori".to_owned()),
                        accelerator: Some(Some("CmdOrCtrl+D".to_owned())),
                        enabled: Some(true),
                    }
                )]
            );
        }

        #[test]
        fn skips_entries_that_match_the_current_menu() {
            let plan = plan_update(
                &applied(),
                &[
                    entry("photo.favorite", "Favorite", None, Some(false)),
                    entry(
                        "photo.delete",
                        "Delete",
                        Some("CmdOrCtrl+Backspace"),
                        Some(true),
                    ),
                    entry("menu.photos", "Photos", None, None),
                ],
            );
            assert!(plan.changes.is_empty());
            assert!(plan.problems.is_empty());
            assert_eq!(plan.unchanged, 3);
        }

        #[test]
        fn a_missing_accelerator_clears_it() {
            let plan = plan_update(
                &applied(),
                &[entry("photo.delete", "Delete", None, Some(true))],
            );
            assert_eq!(plan.changes.len(), 1);
            assert_eq!(plan.changes[0].1.accelerator, Some(None));
        }

        #[test]
        fn only_action_items_take_accelerators_and_enabled_state() {
            let plan = plan_update(
                &applied(),
                &[entry(
                    "menu.photos",
                    "Fotos",
                    Some("CmdOrCtrl+K"),
                    Some(false),
                )],
            );
            assert!(plan.problems.is_empty());
            assert_eq!(
                plan.changes,
                vec![(
                    "menu.photos",
                    ItemChange {
                        label: Some("Fotos".to_owned()),
                        ..ItemChange::default()
                    }
                )]
            );
        }

        #[test]
        fn skips_contract_ids_missing_from_this_platform_without_a_problem() {
            let plan = plan_update(&applied(), &[entry("system.about", "About", None, None)]);
            assert!(plan.problems.is_empty());
            assert!(plan.changes.is_empty());
            assert_eq!(plan.skipped, 1);
        }

        #[test]
        fn reports_unknown_ids_and_bad_values() {
            let plan = plan_update(
                &applied(),
                &[
                    entry("photo.unknown", "Nope", None, None),
                    entry("photo.favorite", "  ", None, None),
                    entry("photo.delete", "Delete", Some("Hyper+Q"), Some(true)),
                ],
            );
            assert_eq!(plan.problems.len(), 3, "{:?}", plan.problems);
            assert!(plan.problems[0].contains("photo.unknown"));
            assert!(plan.problems[1].contains("empty label"));
            assert!(plan.problems[2].contains("Hyper+Q"));
            // The bad accelerator is dropped instead of leaving the previous one in place.
            assert_eq!(plan.changes.len(), 1);
            assert_eq!(plan.changes[0].1.accelerator, Some(None));
        }

        #[test]
        fn deserializes_entries_with_and_without_optional_fields() {
            let entries: Vec<MenuEntry> = serde_json::from_str(
                r#"[
                    {"id":"menu.photos","label":"Photos"},
                    {"id":"photo.delete","label":"Delete","accelerator":null,"enabled":false},
                    {"id":"photo.favorite","label":"Favorite","accelerator":"CmdOrCtrl+D","enabled":true}
                ]"#,
            )
            .expect("entries should deserialize");
            assert_eq!(entries[0], entry("menu.photos", "Photos", None, None));
            assert_eq!(
                entries[1],
                entry("photo.delete", "Delete", None, Some(false))
            );
            assert_eq!(
                entries[2],
                entry(
                    "photo.favorite",
                    "Favorite",
                    Some("CmdOrCtrl+D"),
                    Some(true)
                )
            );
        }
    }
}
