# Go Coverage Action

A Github action for generating test coverage reports for the Go programming language, that does not depend on third party services.

## Overview

This action will generate Go coverage reports for pull requests and other commits without using any third party services, making it suitable for use with private repos.

It stores previous coverage data as git commit notes (in a separate namespace; not normally user-visible) associated with previous commits, so that they can be compared with changes in open pull requests.

It will generate a [job summary](https://github.blog/2022-05-09-supercharging-github-actions-with-job-summaries/) giving coverage statistics on each run and optionally add a comment noting any changes to pull requests:





## Usage

The action will generate a temporary file containing the html report.  It's expected that your workflow will uploaded this report somewhere to make it accessible/viewable, or store it as an artifact.

### Example Comment

![Example comment](./docs/comment.png)


### Example Workflow

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
        report-url: https://artifacts.example.com/go-coverage/${{ github.ref_name}}.html

    - name: Upload coverage to s3
      # ensure this runs regardless of whether the threshold is met using always()
      if: always() && steps.coverage.outputs.report-pathname != ''
      run: |
        aws s3 cp ${{ steps.coverage.outputs.report-pathname }} s3://artifacts.example.com-bucket/go-coverage/${{ github.ref_name}}.html
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

