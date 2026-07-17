# Contributing

## Issues

Search the existing issues before opening a new one, then use the matching issue form.
For security vulnerabilities, follow [SECURITY.md](SECURITY.md) and use GitHub's private
vulnerability reporting. Never publish credentials, device identifiers, real
installation IP addresses, `config/aircos.json`, or unsanitized protocol output.

Compatibility reports for other WF-RAC air conditioners are welcome. Include the air
conditioner model, WF-RAC model and firmware versions, but omit installation-specific
identifiers and addresses.

## Development

AircoBridge requires Node.js 24 or newer. Install dependencies and run the complete
check suite with:

```sh
npm ci
npm run check
```

Keep changes focused. Add or update automated tests for behavior changes and update
the English documentation when user-visible behavior changes. Hardware-dependent
changes should state which air conditioner and WF-RAC models were tested.

## Pull requests

Create a branch in your fork and open a pull request against `main`. Complete the pull
request template, link related issues, and describe both automated and hardware tests.
GitHub Actions runs `npm run check` for every pull request.
