import { pathToFileURL } from 'node:url';

const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[a-f0-9]{40}$/;

export function validateSignedTagRecords(reference, tagObject, { expectedTag, expectedCommit }) {
  if (!TAG.test(expectedTag || '')) throw new Error('Expected release tag is invalid.');
  if (!SHA.test(expectedCommit || '')) throw new Error('Expected release commit is invalid.');
  if (reference?.ref !== `refs/tags/${expectedTag}` || reference?.object?.type !== 'tag') {
    throw new Error(`Release ${expectedTag} must use an annotated tag, not a lightweight tag.`);
  }
  if (tagObject?.tag !== expectedTag || tagObject?.sha !== reference.object.sha) {
    throw new Error('GitHub tag object does not match the release reference.');
  }
  if (tagObject?.object?.type !== 'commit' || tagObject.object.sha !== expectedCommit) {
    throw new Error('Signed release tag does not point to the checked-out commit.');
  }
  if (tagObject?.verification?.verified !== true || tagObject.verification.reason !== 'valid') {
    throw new Error(
      `GitHub did not verify the release tag signature (${tagObject?.verification?.reason || 'unknown'}).`,
    );
  }
  return { tag: expectedTag, commit: expectedCommit, signer: tagObject.tagger?.email || null };
}

async function githubJson(repository, path, token) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aicommit-release-verifier',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = process.env.GITHUB_REF_NAME;
  const commit = process.env.RELEASE_COMMIT || process.env.GITHUB_SHA;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !tag || !commit || !token) {
    throw new Error(
      'GITHUB_REPOSITORY, GITHUB_REF_NAME, RELEASE_COMMIT/GITHUB_SHA, and GITHUB_TOKEN are required.',
    );
  }
  const reference = await githubJson(repository, `git/ref/tags/${encodeURIComponent(tag)}`, token);
  if (reference?.object?.type !== 'tag') {
    validateSignedTagRecords(reference, null, { expectedTag: tag, expectedCommit: commit });
  }
  const tagObject = await githubJson(repository, `git/tags/${reference.object.sha}`, token);
  const verified = validateSignedTagRecords(reference, tagObject, {
    expectedTag: tag,
    expectedCommit: commit,
  });
  process.stdout.write(`Signed GitHub tag verified: ${verified.tag} -> ${verified.commit}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
