export interface GraphInputNode { id: string; objective: string; dependsOn?: readonly string[]; state: string }
export interface GraphNodePosition extends GraphInputNode { rank: number; x: number; y: number }
export function layoutTaskGraph(nodes: readonly GraphInputNode[]): { nodes: GraphNodePosition[]; edges: Array<{ from: string; to: string }>; danglingDependencyIds: string[]; width: number; height: number }
export const NODE_WIDTH: number
export const NODE_HEIGHT: number
export const RANK_GAP: number
export const LANE_GAP: number
