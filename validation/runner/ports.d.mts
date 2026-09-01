export declare const RESERVED_PORTS: Set<number>
export declare function findFreePort(options?: { reserved?: Set<number> | number[]; min?: number; max?: number }): Promise<number>
