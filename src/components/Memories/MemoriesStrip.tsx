import { MemoryCard } from "./MemoryCard";
import { MemoryItem } from "../../utils/memory";

interface MemoriesStripProps {
  memories: MemoryItem[];
  activeMemoryId: string | null;
  onOpenMemory: (memoryId: string) => void;
}

export function MemoriesStrip({
  memories,
  activeMemoryId,
  onOpenMemory,
}: MemoriesStripProps) {
  if (memories.length === 0) {
    return null;
  }

  return (
    <section className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {memories.map((memory) => (
        <MemoryCard
          key={memory.id}
          assetId={memory.coverAssetId}
          label={memory.label}
          name={memory.name}
          isActive={memory.id === activeMemoryId}
          onClick={() => onOpenMemory(memory.id)}
        />
      ))}
    </section>
  );
}
