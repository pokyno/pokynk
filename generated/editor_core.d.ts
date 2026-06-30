// world root:component/root
export type Dims = import('./interfaces/svg-editor-editor-types.js').Dims;
export type Rect = import('./interfaces/svg-editor-editor-types.js').Rect;
export type Point = import('./interfaces/svg-editor-editor-types.js').Point;
export type PixelBuffer = import('./interfaces/svg-editor-editor-types.js').PixelBuffer;
export type DirtyRegion = import('./interfaces/svg-editor-editor-types.js').DirtyRegion;
export type PointerEvent = import('./interfaces/svg-editor-editor-types.js').PointerEvent;
export type KeyEvent = import('./interfaces/svg-editor-editor-types.js').KeyEvent;
export type ToolId = import('./interfaces/svg-editor-editor-types.js').ToolId;
export type ZOrderOp = import('./interfaces/svg-editor-editor-types.js').ZOrderOp;
export type DocTemplate = import('./interfaces/svg-editor-editor-types.js').DocTemplate;
export type LoadError = import('./interfaces/svg-editor-editor-types.js').LoadError;
export type NodeInfo = import('./interfaces/svg-editor-editor-types.js').NodeInfo;
export type DocumentInfo = import('./interfaces/svg-editor-editor-types.js').DocumentInfo;
export type RenderStats = import('./interfaces/svg-editor-editor-types.js').RenderStats;
export type GradientKind = import('./interfaces/svg-editor-editor-types.js').GradientKind;
export type BooleanOp = import('./interfaces/svg-editor-editor-types.js').BooleanOp;
export type AlignMode = import('./interfaces/svg-editor-editor-types.js').AlignMode;
export type AlignRef = import('./interfaces/svg-editor-editor-types.js').AlignRef;
export type DistributeMode = import('./interfaces/svg-editor-editor-types.js').DistributeMode;
export type Bounds = import('./interfaces/svg-editor-editor-types.js').Bounds;
export type * as SvgEditorEditorTypes010 from './interfaces/svg-editor-editor-types.js'; // import svg-editor:editor/types@0.1.0
export type * as WasiCliEnvironment023 from './interfaces/wasi-cli-environment.js'; // import wasi:cli/environment@0.2.3
export type * as WasiCliExit023 from './interfaces/wasi-cli-exit.js'; // import wasi:cli/exit@0.2.3
export type * as WasiCliStderr023 from './interfaces/wasi-cli-stderr.js'; // import wasi:cli/stderr@0.2.3
export type * as WasiCliStdin023 from './interfaces/wasi-cli-stdin.js'; // import wasi:cli/stdin@0.2.3
export type * as WasiCliStdout023 from './interfaces/wasi-cli-stdout.js'; // import wasi:cli/stdout@0.2.3
export type * as WasiCliTerminalInput023 from './interfaces/wasi-cli-terminal-input.js'; // import wasi:cli/terminal-input@0.2.3
export type * as WasiCliTerminalOutput023 from './interfaces/wasi-cli-terminal-output.js'; // import wasi:cli/terminal-output@0.2.3
export type * as WasiCliTerminalStderr023 from './interfaces/wasi-cli-terminal-stderr.js'; // import wasi:cli/terminal-stderr@0.2.3
export type * as WasiCliTerminalStdin023 from './interfaces/wasi-cli-terminal-stdin.js'; // import wasi:cli/terminal-stdin@0.2.3
export type * as WasiCliTerminalStdout023 from './interfaces/wasi-cli-terminal-stdout.js'; // import wasi:cli/terminal-stdout@0.2.3
export type * as WasiClocksWallClock023 from './interfaces/wasi-clocks-wall-clock.js'; // import wasi:clocks/wall-clock@0.2.3
export type * as WasiFilesystemPreopens023 from './interfaces/wasi-filesystem-preopens.js'; // import wasi:filesystem/preopens@0.2.3
export type * as WasiFilesystemTypes023 from './interfaces/wasi-filesystem-types.js'; // import wasi:filesystem/types@0.2.3
export type * as WasiIoError023 from './interfaces/wasi-io-error.js'; // import wasi:io/error@0.2.3
export type * as WasiIoStreams023 from './interfaces/wasi-io-streams.js'; // import wasi:io/streams@0.2.3
export type * as WasiRandomRandom023 from './interfaces/wasi-random-random.js'; // import wasi:random/random@0.2.3
export function load(svg: Uint8Array): void;
export function save(): Uint8Array;
export function newDocument(template: DocTemplate): void;
export function newDocumentSized(width: number, height: number, unit: string): void;
export function setDocumentSize(width: number, height: number, unit: string): DirtyRegion;
export function setPageColor(color: string): DirtyRegion;
export function render(viewport: Rect, size: Dims, maxDownscale: number): PixelBuffer;
export function renderTile(viewport: Rect, size: Dims): PixelBuffer;
export function setView(viewport: Rect, size: Dims): void;
export function renderOverlay(viewport: Rect, size: Dims): PixelBuffer;
export function renderWithoutSelection(viewport: Rect, size: Dims): PixelBuffer;
export function renderBelowSelection(viewport: Rect, size: Dims): PixelBuffer;
export function renderAboveSelection(viewport: Rect, size: Dims): PixelBuffer;
export function renderSelectionSprite(viewport: Rect, size: Dims): PixelBuffer;
export function dragKind(): string;
export function selectionOccluded(): boolean;
export function renderStats(): RenderStats;
export function renderDom(): PixelBuffer;
export function documentBounds(): Rect;
export function documentInfo(): DocumentInfo;
export function nudge(dx: number, dy: number, unit: string): DirtyRegion;
export function computedStyle(node: bigint, property: string): string;
export function setProgressive(on: boolean): void;
export function setSnapping(on: boolean): void;
export function setNodeRetype(on: boolean): void;
export function tick(dtMs: number): DirtyRegion;
export function handlePointer(ev: PointerEvent): DirtyRegion;
export function enterGroup(point: Point): DirtyRegion;
export function handleKey(ev: KeyEvent): DirtyRegion;
export function setTool(tool: ToolId): void;
export function setFill(color: string): DirtyRegion;
export function setFillGradient(kind: GradientKind): DirtyRegion;
export function pathBoolean(op: BooleanOp): DirtyRegion;
export function align(mode: AlignMode, relativeTo: AlignRef): DirtyRegion;
export function distribute(mode: DistributeMode): DirtyRegion;
export function toPath(): DirtyRegion;
export function embedImage(href: string, width: number, height: number): DirtyRegion;
export function selectNode(node: bigint): DirtyRegion;
export function deleteActiveNode(): DirtyRegion;
export function deleteSelection(): DirtyRegion;
export function breakNode(): DirtyRegion;
export function combineNodes(): DirtyRegion;
export function linkNodes(): DirtyRegion;
export function deleteSegment(): DirtyRegion;
export function selectInPolygon(points: Array<Point>): DirtyRegion;
export function setStroke(color: string): DirtyRegion;
export function setStrokeWidth(width: number): DirtyRegion;
export function setStyleProperty(property: string, value: string): DirtyRegion;
export function reorder(op: ZOrderOp): DirtyRegion;
export function group(): DirtyRegion;
export function ungroup(): DirtyRegion;
export function setLayerVisible(node: bigint, visible: boolean): DirtyRegion;
export function setLayerLocked(node: bigint, locked: boolean): DirtyRegion;
export function moveToLayer(layer: bigint): DirtyRegion;
export function createLayer(label: string): bigint;
export function setLayerLabel(node: bigint, label: string): DirtyRegion;
export function createSublayer(parent: bigint, label: string): bigint;
export function reorderLayer(node: bigint, op: ZOrderOp): DirtyRegion;
export function deleteLayer(node: bigint): DirtyRegion;
export function setLayerOpacity(node: bigint, opacity: number): DirtyRegion;
export function undo(): DirtyRegion;
export function redo(): DirtyRegion;
export function documentTree(): Array<NodeInfo>;
export function selectionBounds(): Bounds | undefined;
export function setSelectionBounds(b: Bounds): DirtyRegion;
export function addFont(bytes: Uint8Array): void;
export type Option<T> = { tag: 'none' } | { tag: 'some', val: T };
export type Result<T, E> = { tag: 'ok', val: T } | { tag: 'err', val: E };
