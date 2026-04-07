---
description: Frontend Development Guidance
alwaysApply: true
applyTo: "src/**/*.tsx"
version: 1.0.0
---

# Frontend Development Guidelines

When helping with frontend code, ensure:

## Code Review Checklist

### Component Structure

- [ ] Component is in appropriate directory (`components/`, `pages/`, etc.)
- [ ] Component file is standalone (not embedded in another file)
- [ ] Component has explicit TypeScript interface for props
- [ ] Component has clear single responsibility

### State Management

- [ ] Complex state logic is extracted to a custom hook in `hooks/`
- [ ] Component state is minimal (only UI state, not data)
- [ ] Data fetching uses appropriate hooks
- [ ] No direct API calls in components

### Code Organization

- [ ] Imports are organized (React, third-party, local)
- [ ] Type definitions are above component
- [ ] Component logic is concise and readable
- [ ] No utility functions mixed in component file

### Props & Interfaces

- [ ] All props have explicit type definitions
- [ ] Props interface follows `{ComponentName}Props` naming
- [ ] Props are well-named and self-documenting
- [ ] Unused props are removed

### Best Practices

- [ ] No large embedded components in App.tsx
- [ ] No utility functions left in component files
- [ ] Related utilities grouped in feature files
- [ ] Custom hooks for reusable logic
- [ ] Page components coordinate sub-components

## Common Refactoring Tasks

### When component exceeds 300 lines

1. Identify logical sections
2. Extract sub-components to separate files
3. Create page component that composes them
4. Keep parent focused on data flow

### When utility function appears in component

1. Move to `utils/{feature}.ts`
2. Export as named function
3. Import in component
4. Consider if it should be a hook instead

### When complex logic appears in multiple components

1. Create custom hook in `hooks/`
2. Hook manages state and side effects
3. Component receives data/callbacks from hook
4. Component focuses on rendering

### When component receives many props

1. Group related props into interfaces
2. Consider if some should come from props vs state
3. Check if component is responsible for too much
4. Consider breaking into smaller components

## File Naming Examples

✅ GOOD:

- `MemoryCard.tsx` - single component
- `useSession.ts` - custom hook
- `memory.ts` - utility functions
- `PhotosPage.tsx` - page component

❌ AVOID:

- `MemoryStuff.tsx` - vague name
- `helpers.js` - too generic
- `memory-card.tsx` - React convention is PascalCase
- `AllMemoryComponents.tsx` - multiple components

## Import Organization Example

```tsx
// 1. React & third-party
import { useEffect, useState } from "react";
import { Camera } from "lucide-react";

// 2. Internal - types
import type { AssetSummary } from "../../types";

// 3. Internal - hooks
import { useMemories } from "../../hooks/useMemories";

// 4. Internal - components
import { MemoryCard } from "./MemoryCard";

// 5. Internal - utils
import { toMemoryItem } from "../../utils/memory";
```

## Examples of Correct Patterns

### Minimal App.tsx

```tsx
export function App() {
  const { session, isLoading, login } = useSession();

  if (isLoading) return <LoadingScreen />;
  if (!session) return <LoginScreen onSubmit={login} />;

  return <PhotosPage session={session} />;
}
```

### Page Component

```tsx
export function PhotosPage({ session }: PhotosPageProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const data = useAssets(searchTerm);

  return (
    <div>
      <Sidebar />
      <Header onSearch={setSearchTerm} />
      <PhotoGrid assets={data.assets} />
    </div>
  );
}
```

### Reusable Component

```tsx
interface MemoryCardProps {
  label: string;
  imageUrl: string;
  isActive: boolean;
  onClick: () => void;
}

export function MemoryCard(props: MemoryCardProps) {
  return (
    <button onClick={props.onClick} className={...}>
      <img src={props.imageUrl} alt={props.label} />
      <p>{props.label}</p>
    </button>
  );
}
```

### Custom Hook

```tsx
export function useAssets(searchTerm: string) {
  const [assets, setAssets] = useState([]);

  useEffect(() => {
    fetchAssets(searchTerm).then(setAssets);
  }, [searchTerm]);

  return { assets };
}
```

### Utility Function

```tsx
// utils/memory.ts
export function toMemoryItem(memory: MemorySummary): MemoryItem | null {
  // pure function logic
}
```

## When to Ask for Clarification

- Unclear where a new component should be placed
- Not sure if logic should be a hook vs utility
- Component has too many responsibilities
- Props interface is becoming unwieldy
- Considering embedding components instead of separating
