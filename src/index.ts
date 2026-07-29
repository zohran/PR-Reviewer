import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/rest';
import { fetchPRContext } from './fetchPR';
import { detectLanguage } from './detectLanguage';
import { runTests, type TestResult } from './runTests';
import { runLint, type LintResult } from './lint';
import { llmReview, type LLMReviewResult } from './llmReview';
import { postReview } from './postReview';

const EMPTY_LLM_RESULT: LLMReviewResult = {
  matches_intent: true,
  issues: [],
  summary: 'LLM review was skipped or unavailable.',
};

/**
 * Entry point for the PR Reviewer GitHub Action.
 *
 * Orchestrates fetch → language detect → lint+tests (parallel) → LLM review →
 * post review, isolating failures so one broken step does not abort the rest.
 */
async function run(): Promise<void> {
  try {
    // 1. Inputs
    const token = core.getInput('github-token', { required: true });
    const anthropicApiKey = core.getInput('anthropic-api-key', { required: true });
    const failOnLintErrors = parseBoolInput(
      core.getInput('fail-on-lint-errors'),
      true
    );
    const failOnTestFailure = parseBoolInput(
      core.getInput('fail-on-test-failure'),
      true
    );
    const customTestCommand = core.getInput('custom-test-command') || undefined;

    const context = github.context;
    if (!context.payload.pull_request?.number) {
      core.setFailed('This action must be run on a pull_request event');
      return;
    }

    const workspacePath = process.env.GITHUB_WORKSPACE ?? process.cwd();

    // 2. Octokit
    const octokit = new Octokit({ auth: token });

    // 3. PR context
    const prContext = await fetchPRContext(octokit, context);
    core.info(
      `Fetched PR #${prContext.prNumber}: "${prContext.title}" (${prContext.changedFiles.length} files, ${prContext.commitMessages.length} commits)`
    );

    // 4. Language detection
    const language = detectLanguage(
      prContext.changedFiles,
      prContext.description
    );
    core.info(`Detected language: ${language}`);

    // 5. Lint + tests in parallel (isolated failures)
    const [lintResult, testResult] = await Promise.all([
      runLint(language, workspacePath).catch((error: unknown): LintResult => {
        core.warning(`Lint failed: ${errorMessage(error)}`);
        return {
          issues: [],
          note: `Lint crashed: ${errorMessage(error)}`,
        };
      }),
      runTests(language, workspacePath, customTestCommand).catch(
        (error: unknown): TestResult => {
          core.warning(`Tests failed to run: ${errorMessage(error)}`);
          return {
            ran: false,
            passed: null,
            output: `Tests crashed: ${errorMessage(error)}`,
            exitCode: null,
          };
        }
      ),
    ]);

    // 6. LLM review (optional — outage must not block lint/test review)
    let llmResult: LLMReviewResult;
    try {
      llmResult = await llmReview(
        {
          description: prContext.description,
          commitMessages: prContext.commitMessages,
          changedFiles: prContext.changedFiles,
        },
        anthropicApiKey
      );
    } catch (error: unknown) {
      core.warning(
        `LLM review failed; continuing with lint/test results only: ${errorMessage(error)}`
      );
      llmResult = {
        ...EMPTY_LLM_RESULT,
        summary: `LLM review unavailable: ${errorMessage(error)}`,
      };
    }

    // 7. Post review
    const headSha =
      (context.payload.pull_request as { head?: { sha?: string } } | undefined)
        ?.head?.sha ?? context.sha;

    const composed = await postReview(
      octokit,
      {
        owner: prContext.owner,
        repo: prContext.repo,
        pull_number: prContext.prNumber,
      },
      {
        lintIssues: lintResult.issues,
        testResult,
        llmResult,
        failOnLintErrors,
        failOnTestFailure,
        changedFiles: prContext.changedFiles,
        commitId: headSha,
      }
    );

    // 8. Final summary
    const testsSummary = !testResult.ran
      ? 'not run'
      : testResult.passed
        ? 'passed'
        : 'failed';
    const llmVerdict = llmResult.issues.some((i) => i.severity === 'blocking')
      ? 'blocking issues'
      : llmResult.matches_intent
        ? 'matches intent'
        : 'intent mismatch';

    core.info(
      [
        'PR Review complete:',
        `language=${language}`,
        `tests=${testsSummary}`,
        `lint_issues=${lintResult.issues.length}`,
        `llm=${llmVerdict}`,
        `event=${composed.event}`,
        `inline_comments=${composed.comments.length}`,
      ].join(' ')
    );

    // 9. Fail the check when the review requested changes
    if (composed.event === 'REQUEST_CHANGES') {
      core.setFailed('PR review requested changes');
    }
  } catch (error: unknown) {
    // Uncaught errors — mark the Action failed so the workflow does not hang green
    core.setFailed(errorMessage(error));
  }
}

function parseBoolInput(raw: string, defaultValue: boolean): boolean {
  if (raw === '') {
    return defaultValue;
  }
  return raw.toLowerCase() === 'true';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void run();
