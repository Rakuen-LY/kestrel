# Security policy

Kestrel runs an agent with filesystem and shell access. Treat an exposed instance as a remote
execution service.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes, with fixes backported to the latest patch |
| < 0.1 | No |

## Reporting a vulnerability

**Do not open a public issue.**

Send a private report to the maintainers containing:

- the affected version or commit;
- a minimal reproduction;
- the impact you observed;
- any suggested mitigation.

You will receive an acknowledgement, a triage decision and credit in the advisory unless you prefer
otherwise. Please allow time for a fix before public disclosure.

## Scope

In scope: authentication bypass, path traversal in the HTTP layer, secret leakage in responses or
logs, workspace escape through documented file tools, denial of service through small requests.

Out of scope by design: behaviour that requires the ability to run code in the process (plugins are
not sandboxed), prompt-injection outcomes from content the agent was asked to read, and deployments
that expose the API without a token.

Read the full [security model](docs/guide/security.md) for the threat model, hardening checklist and
known limitations.
