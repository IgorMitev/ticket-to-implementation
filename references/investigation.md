# Investigation

All kinds need `current_behavior` text and `relevant_files`, an array of repository-relative paths investigated (it may be empty for a new project). Feature and mixed also need `feature_analysis` and a `constraints` array.

Before starting bug or mixed investigation, complete the [browser and server preflight](browser-reproduction.md#preflight). Bug and mixed require fresh local runtime reproduction before completing investigation or changing implementation. Read [local-reproduction.md](local-reproduction.md) for the result contract. If reproduction is blocked or unsuccessful, the specific limitation requires explicit user permission through [reproduction-waiver.md](reproduction-waiver.md).

If valid local reproduction evidence was already collected during this run, reuse it. Entering the investigation phase alone does not require another attempt. Confirm that the evidence applies to the current repository, code, environment and reported condition, meets the result contract, and is saved in the active artifact directory; reference it from `reproduction.md` and the investigation result. Repeat a pre-fix attempt only to address a specific evidence gap or changed condition, and record the reason. This reuse does not replace the required post-fix reproduction recheck.
