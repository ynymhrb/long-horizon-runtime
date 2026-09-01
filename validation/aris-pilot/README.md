# ARIS single-task pilot

This runner executes exactly one command for `aris_only` and one for
`aris_plus_long_task`. It rejects a configuration unless all declared control
variables are shared and the only declared treatment difference is the long
task plugin flag. It writes command timing, exit status, redacted output, and
SHA-256 hashes to an immutable evidence directory.

Copy `example.json`, replace its recorded versions and SHA-256 digests, then
replace both `command` vectors with the already-verified DSH invocation for
the identical research prompt and workspace. The runner does not install
ARIS, alter a DSH profile, or prove that a command's profile actually mounted
the declared plugin; retain the DSH startup log in the invoked command's own
artifact directory for that evidence.

```powershell
pnpm aris:pilot -- --config .\aris-pilot.json --evidence-root .\validation\evidence
```

Exit code `0` means both one-seed commands exited successfully; `1` preserves
evidence for one or both failed commands; `2` means invalid pilot input. This
is an operational pilot, not a statistical result or a blind research-quality
review.
