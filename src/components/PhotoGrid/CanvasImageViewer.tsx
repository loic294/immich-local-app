import { useEffect, useRef, useState } from "react";

interface CanvasImageViewerProps {
  src: string;
  alt: string;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  containerWidth: number;
  containerHeight: number;
  onNavigate?: (direction: "prev" | "next") => void;
}

export function CanvasImageViewer({
  src,
  alt,
  zoom,
  onZoomChange,
  containerWidth,
  containerHeight,
  onNavigate,
}: CanvasImageViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchDistanceRef = useRef<number | null>(null);
  const touchZoomStartRef = useRef<number | null>(null);
  const touchStartXRef = useRef<number | null>(null);

  // Calculate distance between two touch points
  const getTouchDistance = (
    touch1: React.Touch,
    touch2: React.Touch,
  ): number => {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Load image
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageRef.current = img;
      setPanX(0);
      setPanY(0);
      drawCanvas();
    };
    img.onerror = () => {
      console.error("Failed to load image in canvas viewer");
    };
    img.src = src;
  }, [src]);

  // Draw canvas
  const drawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas || !imageRef.current) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = imageRef.current;

    // Calculate base fit (100% means image fits within canvas)
    const imageAspectRatio = img.width / img.height;
    const canvasAspectRatio = canvas.width / canvas.height;

    let baseWidth = canvas.width;
    let baseHeight = canvas.height;

    if (imageAspectRatio > canvasAspectRatio) {
      // Image is wider, fit to width
      baseHeight = canvas.width / imageAspectRatio;
    } else {
      // Image is taller or square, fit to height
      baseWidth = canvas.height * imageAspectRatio;
    }

    // Apply zoom to the base fit dimensions
    const zoomedWidth = (baseWidth * zoom) / 100;
    const zoomedHeight = (baseHeight * zoom) / 100;

    // Clear canvas
    ctx.fillStyle = "rgb(0, 0, 0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Keep image centered by default at every zoom level; pan values are offsets.
    const centerX = (canvas.width - zoomedWidth) / 2;
    const centerY = (canvas.height - zoomedHeight) / 2;
    const drawX = centerX + panX;
    const drawY = centerY + panY;

    // Draw image
    ctx.drawImage(img, drawX, drawY, zoomedWidth, zoomedHeight);
  };

  // Redraw when zoom or pan changes
  useEffect(() => {
    drawCanvas();
  }, [zoom, panX, panY, containerWidth, containerHeight]);

  useEffect(() => {
    if (zoom === 100) {
      setPanX(0);
      setPanY(0);
    }
  }, [zoom]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    panStartRef.current = { x: panX, y: panY };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging || !dragStartRef.current || !panStartRef.current) return;

    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;

    setPanX(panStartRef.current.x + dx);
    setPanY(panStartRef.current.y + dy);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    dragStartRef.current = null;
    panStartRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const scrollDelta = e.deltaY > 0 ? -5 : 5;
    const newZoom = Math.max(5, Math.min(800, zoom + scrollDelta));
    onZoomChange(newZoom);
  };

  const handleDoubleClick = () => {
    onZoomChange(zoom === 100 ? 200 : 100);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      touchDistanceRef.current = distance;
      touchZoomStartRef.current = zoom;
      touchStartXRef.current =
        (e.touches[0].clientX + e.touches[1].clientX) / 2;
      setIsDragging(true);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (
      e.touches.length === 2 &&
      touchDistanceRef.current !== null &&
      touchZoomStartRef.current !== null
    ) {
      e.preventDefault();
      const currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
      const distanceDelta = currentDistance - touchDistanceRef.current;

      // Convert distance change to zoom change (adjust sensitivity as needed)
      const zoomDelta = (distanceDelta / 100) * 50;
      const newZoom = Math.max(
        5,
        Math.min(800, touchZoomStartRef.current + zoomDelta),
      );

      onZoomChange(newZoom);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length < 2) {
      // Two-finger swipe detection
      if (touchStartXRef.current !== null && e.changedTouches.length >= 2) {
        const endX =
          (e.changedTouches[0].clientX + e.changedTouches[1].clientX) / 2;
        const swipeDelta = touchStartXRef.current - endX;

        // If swipe is significant (at least 50px)
        if (Math.abs(swipeDelta) > 50 && onNavigate) {
          if (swipeDelta > 0) {
            // Swiped left, go to next photo
            onNavigate("next");
          } else {
            // Swiped right, go to previous photo
            onNavigate("prev");
          }
        }
      }

      setIsDragging(false);
      touchDistanceRef.current = null;
      touchZoomStartRef.current = null;
      touchStartXRef.current = null;
    }
  };

  return (
    <canvas
      ref={canvasRef}
      width={containerWidth}
      height={containerHeight}
      className="max-h-full max-w-full object-contain cursor-grab active:cursor-grabbing"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      title={alt}
    />
  );
}
