import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function identity(test) {
  return {
    id: test.id,
    project: test.parent.project().name,
    title: test.titlePath(),
    location: test.location,
  };
}

// Each synchronous append survives termination without needing onEnd or final JSON.
export default class InstallationReporter {
  constructor({ outputFile = "playwright-report/installation-results.jsonl" } = {}) {
    this.outputFile = resolve(outputFile);
  }

  write(record) {
    appendFileSync(this.outputFile, `${JSON.stringify(record)}\n`);
  }

  onBegin(config, suite) {
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, "");
    this.write({
      event: "inventory",
      startedAt: new Date().toISOString(),
      tests: suite.allTests().map((test) =>
        Object.assign(identity(test), {
          expectedStatus: test.expectedStatus,
          annotations: test.annotations,
          status: "incomplete",
        }),
      ),
    });
  }

  onTestBegin(test, result) {
    this.write({
      event: "start",
      ...identity(test),
      retry: result.retry,
      startedAt: result.startTime.toISOString(),
    });
  }

  onTestEnd(test, result) {
    const firstLoad = result.attachments.filter(({ name }) => name === "first-load-timing");
    const timings = firstLoad.map((attachment) => {
      const body = attachment.body ?? readFileSync(attachment.path);
      return JSON.parse(body.toString("utf8"));
    });
    const record = {
      event: "result",
      ...identity(test),
      status: result.status,
      expectedStatus: test.expectedStatus,
      annotations: test.annotations,
      duration: result.duration,
      retry: result.retry,
      errors: result.errors,
      firstLoadTimings: timings,
    };
    this.write(record);
    process.stdout.write(`INSTALLATION_RESULT ${JSON.stringify(record)}\n`);
  }

  onEnd(result) {
    this.write({ event: "end", status: result.status, duration: result.duration });
  }
}
