# Long-Task Runtime V1 implementation decisions

## Development dependency links

The published package declares DSH packages as peer dependencies. Local development links its DSH dev dependencies to `D:\code_github\deepseek-harness` package directories so tests compile against the requested checkout rather than a mismatched registry release. `@deepseek-ai/cordis` is version `4.0.1`; it is not part of the `0.1.0-rc.7` DSH package version family.
