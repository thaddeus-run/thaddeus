# One version per Thaddeus release

Thaddeus will enforce its existing shared-version release convention across
release-versioned first-party packages and binaries, including agreement with
the release tag. Independent package versions would allow one release's
launchers and embedded binary versions to disagree, so consistency checks must
cover the release as a whole rather than only current CLI documentation. Every
release stage uses the commit named by the verified tag. A nightly stamps its
version into the files in the release runner and creates its tag at the built
commit when it publishes; nothing is committed back. Historical release records
retain the versions they actually describe.
