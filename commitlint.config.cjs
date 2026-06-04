// Conventional Commits — enforced in CI (lint-commits) and used by release-please to
// derive versions + the changelog.
module.exports = {
  extends: ["@commitlint/config-conventional"],
};
