# Example apps

Sample sources for deploying through ForgeCloud.

## `hello-forge`

A zero-dependency Node app. `npm install` therefore needs no network and
finishes instantly, and `npm run build` prints ~50 lines (plus one on stderr)
so a demo has real streamed output to watch. The build stamps the `FORGE_*`
variables the worker injects into `dist/build-info.json`, which is how you can
see that the injected environment reached the build.

Pack it the way the dashboard's upload expects:

```bash
# tar.gz — what the tar reader handles
tar -czf /tmp/hello-forge.tgz -C examples hello-forge
# or zip — what the yauzl reader handles
( cd examples && zip -qr /tmp/hello-forge.zip hello-forge )
```

Upload either through the project's **Source** panel, then hit **Deploy**. The
archive has a single top-level directory, so the pipeline descends into it and
says so in the build log; leave the project's `rootDir` at `.`.
