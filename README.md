# Go Coverage Action

A Github action for generating Go coverage reports.

## Overview

This action will generate Go coverage reports without using any third party services, rendinerg it suitable for use with private repos.

It stores previous coverage data as git commit notes associated with previous shas, so that they can be compared with changes in open pull requests.

It's a rough and ready work in progress.

## Usage

The action will generate a temporary file containing the html report.  It's expected that your workflow will uploaded this report somewhere to make it accessible/viewable, or store it as an artifact.

e.g.

```yaml
name: "Go Coverage"
on:
  pull_request:
  push:
    branches:
      - main
      - 'releases/*

jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
      with:
        # default fetch-depth is insufficent to find previous coverage notes
        fetch-depth: 10
    - uses: gwatts/go-coverage-action@v1
      id: coverage
      with:
        # Optional coverage threshold; check will fail if coverage is
        # below this number
        coverage-threshold: 80
        
        # A url that the html report will be accessible at, once your
        # workflow uploads it
        # used in the pull request comment.
        report-url: https://artifacts.example.com/go-coverage/${{ github.sha}}.html

        # Github token to give permission to post the comment
        # token: ${{ github.token }}

        # Directory to execute go test from; defaults to the
        # current directory
        # working-directory: ./my-go-files

        # Override the report filename
        # report-filename: coverage.html

        # Additional arguments to pass to go test, must be a JSON array
        # test-args: '["-tags", "mytag"]'

    - name: Upload coverage to s3
      # ensure this runs whether the threshold is met, or not using always()
      if: always() && steps.coverage.outputs.report-pathname != ''
      run: |
        aws s3 cp ${{ steps.coverage.outputs.report-pathname }} s3://artifacts.example.com-bucket/go-coverage/${{ github.sha}}.html
```

##
