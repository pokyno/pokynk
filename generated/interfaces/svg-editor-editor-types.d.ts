/** @module Interface svg-editor:editor/types@0.1.0 **/
export interface Dims {
  width: number,
  height: number,
}
export interface Rect {
  x: number,
  y: number,
  width: number,
  height: number,
}
export interface Point {
  x: number,
  y: number,
}
export interface PixelBuffer {
  size: Dims,
  data: Uint8Array,
}
export interface DirtyRegion {
  full: boolean,
  area?: Rect,
}
/**
 * # Variants
 * 
 * ## `"down"`
 * 
 * ## `"moved"`
 * 
 * ## `"up"`
 * 
 * ## `"enter"`
 * 
 * ## `"leave"`
 */
export type PointerPhase = 'down' | 'moved' | 'up' | 'enter' | 'leave';
/**
 * # Variants
 * 
 * ## `"left"`
 * 
 * ## `"middle"`
 * 
 * ## `"right"`
 */
export type PointerButton = 'left' | 'middle' | 'right';
export interface Modifiers {
  shift: boolean,
  ctrl: boolean,
  alt: boolean,
  meta: boolean,
}
export interface PointerEvent {
  phase: PointerPhase,
  position: Point,
  button?: PointerButton,
  scrollY: number,
  modifiers: Modifiers,
}
/**
 * # Variants
 * 
 * ## `"down"`
 * 
 * ## `"up"`
 */
export type KeyPhase = 'down' | 'up';
export interface KeyEvent {
  phase: KeyPhase,
  key: string,
  text?: string,
  modifiers: Modifiers,
}
/**
 * # Variants
 * 
 * ## `"select"`
 * 
 * ## `"node"`
 * 
 * ## `"rect"`
 * 
 * ## `"ellipse"`
 * 
 * ## `"star"`
 * 
 * ## `"pen"`
 * 
 * ## `"text"`
 * 
 * ## `"zoom"`
 * 
 * ## `"gradient"`
 */
export type ToolId = 'select' | 'node' | 'rect' | 'ellipse' | 'star' | 'pen' | 'text' | 'zoom' | 'gradient';
/**
 * # Variants
 * 
 * ## `"raise-one"`
 * 
 * ## `"lower-one"`
 * 
 * ## `"raise-to-top"`
 * 
 * ## `"lower-to-bottom"`
 */
export type ZOrderOp = 'raise-one' | 'lower-one' | 'raise-to-top' | 'lower-to-bottom';
/**
 * # Variants
 * 
 * ## `"blank-px"`
 * 
 * ## `"blank-mm"`
 * 
 * ## `"a4-portrait"`
 * 
 * ## `"a4-landscape"`
 */
export type DocTemplate = 'blank-px' | 'blank-mm' | 'a4-portrait' | 'a4-landscape';
export type LoadError = LoadErrorNotXml | LoadErrorNotSvg | LoadErrorIo;
export interface LoadErrorNotXml {
  tag: 'not-xml',
  val: string,
}
export interface LoadErrorNotSvg {
  tag: 'not-svg',
  val: string,
}
export interface LoadErrorIo {
  tag: 'io',
  val: string,
}
export interface NodeInfo {
  id: bigint,
  depth: number,
  tag: string,
  label?: string,
  isLayer: boolean,
  visible: boolean,
  locked: boolean,
  selected: boolean,
}
export interface DocumentInfo {
  viewBox: Rect,
  widthPx: number,
  heightPx: number,
  displayUnit: string,
  userPerPx: number,
  pageColor: string,
}
export interface RenderStats {
  frames: bigint,
  rasterizations: bigint,
  cacheHits: bigint,
}
/**
 * # Variants
 * 
 * ## `"linear"`
 * 
 * ## `"radial"`
 */
export type GradientKind = 'linear' | 'radial';
/**
 * # Variants
 * 
 * ## `"union"`
 * 
 * ## `"difference"`
 * 
 * ## `"intersection"`
 * 
 * ## `"exclusion"`
 */
export type BooleanOp = 'union' | 'difference' | 'intersection' | 'exclusion';
/**
 * # Variants
 * 
 * ## `"left"`
 * 
 * ## `"h-center"`
 * 
 * ## `"right"`
 * 
 * ## `"top"`
 * 
 * ## `"v-middle"`
 * 
 * ## `"bottom"`
 */
export type AlignMode = 'left' | 'h-center' | 'right' | 'top' | 'v-middle' | 'bottom';
/**
 * # Variants
 * 
 * ## `"selection"`
 * 
 * ## `"page"`
 */
export type AlignRef = 'selection' | 'page';
/**
 * # Variants
 * 
 * ## `"horizontal"`
 * 
 * ## `"vertical"`
 */
export type DistributeMode = 'horizontal' | 'vertical';
export interface Bounds {
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
}
