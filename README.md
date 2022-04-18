# Go Coverage Action

A Github action for generating Go coverage reports that does not depend on third party services.

## Overview

This action will generate Go coverage reports without using any third party services, making it suitable for use with private repos.

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
        # Optional coverage threshold
        # use fail-coverage to determine what should happen below this threshold
        coverage-threshold: 80
        
        # A url that the html report will be accessible at, once your
        # workflow uploads it.
        # used in the pull request comment.
        report-url: https://artifacts.example.com/go-coverage/${{ github.sha}}.html

    - name: Upload coverage to s3
      # ensure this runs whether the threshold is met, or not using always()
      if: always() && steps.coverage.outputs.report-pathname != ''
      run: |
        aws s3 cp ${{ steps.coverage.outputs.report-pathname }} s3://artifacts.example.com-bucket/go-coverage/${{ github.sha}}.html
```


If you want to generate a badge to put in the readme, you could add an extra step to the workflow to create one.  For example using the [dynamic badges action](https://github.com/Schneegans/dynamic-badges-action):


```yaml
    - name: Update coverage badge
      uses: schneegans/dynamic-badges-action@v1.3.0
      if: github.ref_name == 'main'
      with:
        auth: ${{ secrets.COVERAGE_GIST_SECRET }}
        gistID: 788ds7a07299ab2728a33
        filename: coverage.json
        label: Go Coverage
        message: ${{ steps.coverage.outputs.coverage-pct }}%
        color: ${{ steps.coverage.outputs.meets-threshold == 'true' && 'green' || 'red' }}
```

##
