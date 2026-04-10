---
description: Frontend Modular Architecture Guidelines
alwaysApply: true
applyTo: "src/**/*.tsx"
version: 1.1.0
---

# Frontend Modular Architecture

## Core Principles

The frontend is organized to maximize reusability, maintainability, and readability through modular component architecture. All developers must follow these guidelines when creating or modifying frontend code.

## Project-Specific Rules

### 1. Shared PhotoGrid Contract

**Rule**: Photos, Albums, Calendar, and Folders all use the same `PhotoGrid` component. Any feature added to this grid must work across all four pages.

- Do not implement page-specific grid behavior by forking `PhotoGrid`
- Extend shared `PhotoGrid` props, extracted hooks, or supporting child components instead
- When changing fullscreen behavior, selection, layout, metadata display, or loading behavior, verify the change still works in Photos, Albums, Calendar, and Folders

### 2. Always Prefer Tauri Full Grid Layouts

**Rule**: When a page has access to a full photo grid layout calculated in Tauri, always use that full layout.

- Prefer cached full-grid layout commands from Tauri over recalculating the complete layout in React
- Frontend layout calculation is only a fallback for cases where no Tauri full-layout source exists
- New pages or new asset sources that render `PhotoGrid` should expose a Tauri full-layout loader whenever possible

### 3. Guard Against Fetch Loops

**Rule**: Be deliberate with effects, pagination triggers, and API calls so UI state changes cannot accidentally create repeated fetch loops.

- Never trigger API calls during render
- Effects that fetch data must use stable dependencies and explicit guards
- Infinite scroll, jump-to-date, and layout-loading flows must protect against duplicate in-flight requests
- When a fetch updates state that can retrigger the same effect, add cancellation and loop-prevention guards with refs or equivalent control flow

### 4. Keep Files Small

**Rule**: Keep files as small as practical. Prefer creating a new file over making an existing file significantly larger.

- If a file is growing because of a new concern, extract that concern into a new component, hook, or utility
- Avoid adding unrelated responsibilities to already-large page or component files
- Treat file size growth as a design smell, especially in `pages/` and `components/PhotoGrid/`

### 5. Extract Reusable Components Early

**Rule**: If UI or behavior is reused, create a dedicated component instead of duplicating code.

- Repeated JSX should usually become a component
- Repeated stateful logic should usually become a hook
- Shared transformations should usually become utilities

### 6. Preserve Grid Data Completeness

**Rule**: Any asset source rendered in `PhotoGrid` must supply the data required for stable layout and fullscreen metadata.

- Width, height, creation date, asset type, and thumbhash must remain available for layout stability
- Asset sources shown in fullscreen should preserve enough metadata for the info panel and related actions to work consistently
- Do not regress one source, such as albums or folders, while improving another

## Directory Structure

```
src/
├── components/              # Reusable UI components
│   ├── Auth/               # Authentication-related components
│   │   └── LoginScreen.tsx
│   ├── Layout/             # Layout/shell components
│   │   ├── Sidebar.tsx
│   │   ├── Header.tsx
│   │   └── LoadingScreen.tsx
│   ├── Memories/           # Memory feature components
│   │   ├── MemoryCard.tsx
│   │   ├── MemoriesStrip.tsx
│   │   └── MemoryFullscreenViewer.tsx
│   └── PhotoGrid/          # Photo grid component
│       └── PhotoGrid.tsx
├── pages/                   # Page-level components (combine sections)
│   └── PhotosPage.tsx
├── hooks/                   # Custom React hooks
│   ├── useSession.ts       # Session management
│   ├── useAssets.ts        # Asset data fetching
│   └── useMemories.ts      # Memory data fetching
├── utils/                   # Utility functions
│   ├── memory.ts           # Memory-related utilities
│   └── date.ts             # Date formatting utilities
├── api/                     # API integration
│   └── tauri.ts
├── types.ts                # TypeScript type definitions
├── App.tsx                 # Minimal entry component
├── main.tsx                # React root setup
└── styles.css              # Global styles
```

## Component Guidelines

### 1. Component Separation

**Rule**: Each component should have a single responsibility and be placed in its own file.

- Small components: ~50-200 lines
- Medium components: ~200-400 lines
- Large components (Pages): ~400+ lines should be split unless there is a strong reason not to

**Example**: Instead of combining `MemoryCard`, `MemoriesStrip`, and `MemoryFullscreenViewer` in one file, create separate files.

### 2. Component Organization

**Rule**: Organize components into logical groupings based on feature/domain.

- **Layout components** (`Layout/`): Sidebar, Header, LoadingScreen - used for page structure
- **Feature components** (`Memories/`, `PhotoGrid/`, `Auth/`): Feature-specific UI elements
- **Page components** (`pages/`): Combine multiple components into full pages

### 3. Props Interface

**Rule**: Always define explicit TypeScript interfaces for component props.

```tsx
// ✅ GOOD
interface MemoryCardProps {
  assetId: string;
  label: string;
  name: string;
  isActive: boolean;
  onClick: () => void;
}

export function MemoryCard(props: MemoryCardProps) {
  // ...
}

// ❌ BAD
export function MemoryCard({ assetId, label, name, isActive, onClick }) {
  // ...
}
```

### 4. Custom Hooks

**Rule**: Extract stateful logic into custom hooks, especially for data fetching and session management.

- Hooks should be placed in `src/hooks/`
- Hook names must start with `use` prefix
- Return type should be explicit

**Example**: `useSession()` manages all session state without embedding logic in App.tsx

### 5. Utility Functions

**Rule**: Extract pure utility functions into `utils/` directory, organized by feature.

- `utils/memory.ts`: Memory-related helpers (`toMemoryItem`, `getYearsAgoLabel`)
- `utils/date.ts`: Date formatting helpers (`formatMemoryDate`)
- Keep utilities pure (no side effects, no hooks)

## App.tsx Structure

**Rule**: App.tsx should remain minimal and only handle:

1. Session/auth state (via custom hook)
2. Conditional rendering (loading/login/main views)
3. Top-level page routing

**Example Structure**:

```tsx
export function App() {
  const { session, isRestoringSession, login, error } = useSession();

  if (isRestoringSession) return <LoadingScreen />;
  if (!session) return <LoginScreen onSubmit={login} error={error} />;

  return <PhotosPage session={session} />;
}
```

## Page Components

**Rule**: Page components (in `pages/`) should:

1. Accept minimal props (session, navigation state)
2. Manage page-level state and data fetching
3. Compose layout and feature components
4. Pass data/callbacks to child components
5. Adapt shared components instead of duplicating shared behavior per page

**Example Structure**:

```tsx
export function PhotosPage({ session }: PhotosPageProps) {
  const [searchInput, setSearchInput] = useState("");
  const assetsQuery = useAssets(true, searchTerm);

  return (
    <main>
      <Sidebar />
      <Header searchInput={searchInput} onSearchChange={setSearchInput} />
      <PhotoGrid assets={assets} />
    </main>
  );
}
```

## Data Flow

1. **API/Hooks**: Custom hooks handle data fetching
2. **Pages**: Pages manage state and coordinate child components
3. **Components**: Components receive data via props and emit events via callbacks
4. **Utilities**: Pure functions handle data transformation

**Example**:

```
useAssets (hook)
  → PhotosPage (gets data, passes to PhotoGrid)
    → PhotoGrid (receives data, renders)
```

For shared grid flows:

```
Tauri cached layout command
  → page hook/page component
    → PhotoGrid
```

## Naming Conventions

- Component files: PascalCase (`MemoryCard.tsx`)
- Hook files: camelCase (`useSession.ts`)
- Utility files: camelCase (`memory.ts`, `date.ts`)
- Component exports: PascalCase (`function MemoryCard() {}`)
- Hook exports: camelCase (`function useSession() {}`)

## Code Organization Within Files

For component files, organize in this order:

1. Imports
2. Type/Interface definitions
3. Component implementation
4. Export statement

## Testing & Documentation

- Components with complex logic should have JSDoc comments
- Props interfaces should be self-documenting
- Utility functions should include docstrings

## Anti-Patterns to Avoid

❌ **Avoid**:

- Embedding large amounts of logic in App.tsx
- Multiple components in a single file
- Mixing data fetching logic in components (use hooks)
- Leaving utility functions scattered throughout components
- Generic prop names like `data`, `callback`, `handler`
- Adding a grid feature to one page while forgetting the other pages that reuse `PhotoGrid`
- Triggering repeated API calls from unstable effect dependencies or scroll handlers without in-flight guards
- Recomputing full layouts in the frontend when a Tauri full-layout source already exists

✅ **Do Instead**:

- Extract to custom hooks
- One component per file
- Create custom hooks for complex logic
- Centralize utilities in dedicated files
- Use descriptive names
- Extend shared grid APIs and verify all grid pages still behave correctly
- Use guarded async flows with cancellation and duplicate-request protection
- Prefer Tauri full-layout loaders for shared photo grid pages

## When to Create New Components

Create a new component when:

- It will be reused in multiple places
- A single component exceeds 300 lines of logic
- A section can be independently understood and tested
- A component has clear inputs and outputs (props/events)
- A repeated `PhotoGrid` subview or fullscreen panel concern appears across multiple contexts

## When to Use Utilities

Use utility functions when:

- Logic is pure (no state or side effects)
- Function is used in multiple components
- Function can be independently unit tested
- Logic is distinct from UI rendering
