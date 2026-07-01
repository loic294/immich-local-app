import { MemoryCard } from "./MemoryCard";
import { MemoryItem } from "../../utils/memory";

interface MemoriesStripProps {
  memories: MemoryItem[];
  activeMemoryId: string | null;
  onOpenMemory: (memoryId: string) => void;
}

export function MemoriesStrip({ memories, activeMemoryId, onOpenMemory }: MemoriesStripProps) {
  if (memories.length === 0) {
    return null;
  }

  return (
    <section className="mb-3 flex gap-2 overflow-x-auto">
      {memories.map((memory) => (
        <MemoryCard
          key={memory.id}
          assetId={memory.coverAssetId}
          accountId={memory.accountId}
          label={memory.label}
          name={memory.name}
          isActive={memory.id === activeMemoryId}
          onClick={() => onOpenMemory(memory.id)}
        />
      ))}
    </section>
  );
}
