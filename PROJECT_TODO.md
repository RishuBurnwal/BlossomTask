# BlossomTask Fix Todo

Last updated: 2026-05-02

## Current Priority Queue

1. Fix cron schedule config mismatch between UI and backend.
Status: Completed
Needed:
- make reverify usage an explicit schedule setting
- make updater/pipeline model selection mandatory for cron
- save those fields with the schedule
- show them back in the schedule card

2. Block invalid enabled schedules at creation time.
Status: Completed
Needed:
- apply the same mandatory validation on schedule create that already exists on enable/update

3. Make reverify live progress real.
Status: Completed
Needed:
- emit `REVERIFY_TOTAL|N`
- emit `REVERIFY_PROGRESS|current|total`
- verify frontend reflects numeric progress

4. Reduce reverify overprocessing.
Status: Completed
Needed:
- ensure cron can skip reverify entirely
- ensure saved schedule sequence exactly matches reverify choice
- confirm same-config guard and latest-count paths still behave correctly

5. Tighten pipeline stop conditions and reporting.
Status: Completed
Needed:
- re-check pipeline failure behavior when a scheduled step fails
- ensure next run waits for completion + cooldown
- update error report entries with any newly found breakpoints

6. Refresh session/logout UX.
Status: Completed
Needed:
- verify sign out
- verify sign out everywhere
- verify clear other sessions
- refresh relevant cached queries after each action

7. Verify full behavior after fixes.
Status: Completed
Needed:
- local compile/type checks
- backend syntax check
- isolated cron demo verification
- update fix report with results

## Strict Completion Rules

- A task is not complete until the code change is verified.
- Cron is not considered fixed until schedule config, saved schedule details, and repeated trigger behavior all agree.
- Reverify is not considered fixed until its live progress is numeric and its run scope matches operator choice.
- Documentation is not considered complete unless the audit, guide, and todo all reflect the current real behavior.
