#!/usr/bin/env pwsh
$basedir = Split-Path $MyInvocation.MyCommand.Path -Parent
& node "$basedir/../scripts/gemini-runner.mjs" $args
exit $LASTEXITCODE
