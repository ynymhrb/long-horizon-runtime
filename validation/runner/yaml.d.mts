export declare class YamlParseError extends Error {
  constructor(message: string, line: number)
  line: number
}
export declare function parseYaml(text: string): unknown
