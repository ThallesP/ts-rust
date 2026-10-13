// One scenario run: its steps (commands with logs and exit codes), checks, artifacts (outputs
// that compare.mjs diffs) and the status.json that records them.

import fs from "node:fs";
import path from "node:path";

import { httpRequest, runCommand, startService, freePort, portIsOpen } from "./proc.mjs";
import {
    cachedLockFile,
    dropTypescriptFromLock,
    npmEnv,
    restoreCachedLock,
    saveCachedLock,
    useTarballInPackageJson,
    verifyInstall,
} from "./sources.mjs";
import { copyTree, hashTree, isoNow, manifestHash, normalizeOutput, readJson, removePath, writeJson } from "./util.mjs";

const minute = 60_000;

export class ScenarioContext {
    constructor({ scenario, outDir, appDir, pack, baseEnv, userEnv }) {
        this.scenario = scenario;
        this.outDir = outDir;
        this.appDir = appDir;
        this.pack = pack;
        this.baseEnv = baseEnv;
        this.userEnv = userEnv;
        this.steps = [];
        this.checks = [];
        this.artifacts = {};
        this.tests = {};
        this.metrics = {};
        this.notes = [];
        this.install = undefined;
        this.startedAt = isoNow();
        this.started = Date.now();
        removePath(outDir);
        fs.mkdirSync(path.join(outDir, "logs"), { recursive: true });
    }

    // Commands of the app (builds, tests, the app itself) get the --env additions; npm installs
    // do not, so that NODE_OPTIONS preloads never run inside npm.
    env({ install = false, extra = {} } = {}) {
        const env = { ...this.baseEnv, NO_COLOR: "1", FORCE_COLOR: "0", CI: "true" };
        if (install) {
            return npmEnv({ ...env, ...extra });
        }
        return { ...env, ...this.userEnv, ...extra };
    }

    logFile(name) {
        const index = String(this.steps.length + 1).padStart(2, "0");
        return path.join(this.outDir, "logs", `${index}-${name}.log`);
    }

    async step(name, cmd, args, { cwd = this.appDir, timeoutMs = 10 * minute, install = false, env = {}, required = true } = {}) {
        const logFile = this.logFile(name);
        const result = await runCommand({ cmd, args, cwd, env: this.env({ install, extra: env }), logFile, timeoutMs });
        const step = {
            name,
            command: [cmd, ...args].join(" "),
            cwd: path.relative(this.appDir, cwd) || ".",
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            spawnError: result.spawnError,
            ms: result.ms,
            ok: result.exitCode === 0,
            required,
            log: path.relative(this.outDir, logFile),
        };
        this.steps.push(step);
        return step;
    }

    stepOutput(step) {
        const text = fs.readFileSync(path.join(this.outDir, step.log), "utf8");
        const body = text.slice(text.indexOf("\n\n") + 2);
        return body.replace(/\n\[harness\] exit=.*\n?$/, "\n");
    }

    check(name, ok, detail = undefined, { severity = "required" } = {}) {
        this.checks.push({ name, ok: Boolean(ok), severity, detail });
        return Boolean(ok);
    }

    note(text) {
        this.notes.push(text);
    }

    normalize(text) {
        return normalizeOutput(text, [
            [this.appDir, "<app>"],
            [this.pack.tgz, "<typescript.tgz>"],
        ]);
    }

    // Output of a build step with paths, times and durations replaced, kept as an artifact.
    saveStepOutput(name, step) {
        this.saveText(name, this.normalize(this.stepOutput(step)));
    }

    saveTree(name, fromRel) {
        const from = path.join(this.appDir, fromRel);
        if (!fs.existsSync(from)) {
            this.artifacts[name] = { kind: "tree", path: name, missing: true };
            return false;
        }
        copyTree(from, path.join(this.outDir, name));
        const manifest = hashTree(path.join(this.outDir, name));
        this.artifacts[name] = { kind: "tree", path: name, files: Object.keys(manifest).length, treeHash: manifestHash(manifest) };
        return true;
    }

    // Records a tree that a scenario already wrote into <out>/<name>.
    saveTreeFromOut(name) {
        const manifest = hashTree(path.join(this.outDir, name));
        const files = Object.keys(manifest).length;
        this.artifacts[name] = { kind: "tree", path: name, files, treeHash: manifestHash(manifest), missing: files === 0 || undefined };
    }

    // informational artifacts are diffed by compare but never counted as a difference.
    saveFile(name, fromRel, kind = "file", { informational = false } = {}) {
        const from = path.join(this.appDir, fromRel);
        const flag = informational ? { informational } : {};
        if (!fs.existsSync(from)) {
            this.artifacts[name] = { kind, path: name, missing: true, ...flag };
            return false;
        }
        fs.copyFileSync(from, path.join(this.outDir, name));
        this.artifacts[name] = { kind, path: name, ...flag };
        return true;
    }

    saveText(name, text, kind = "file") {
        fs.mkdirSync(path.dirname(path.join(this.outDir, name)), { recursive: true });
        fs.writeFileSync(path.join(this.outDir, name), text);
        this.artifacts[name] = { kind, path: name };
    }

    saveHttp(name, response) {
        const body = parseJson(response.text);
        const record = { status: response.status, contentType: response.contentType, error: response.error, body: body ?? response.text };
        this.saveText(`http/${name}.json`, `${JSON.stringify(record, null, 2)}\n`, "json");
    }

    // package.json -> the tarball plus the override; the lockfile without its typescript entries.
    useTarball({ lockKey, extraDependencies, extraDevDependencies } = {}) {
        useTarballInPackageJson(this.appDir, this.pack.tgz, { extraDependencies, extraDevDependencies });
        if (lockKey !== undefined && restoreCachedLock(lockKey, this.appDir)) {
            this.note(`lockfile restored from ${path.relative(this.appDir, cachedLockFile(lockKey))}`);
        }
        dropTypescriptFromLock(path.join(this.appDir, "package-lock.json"));
    }

    saveLock(lockKey) {
        saveCachedLock(lockKey, this.appDir);
    }

    verifyInstall() {
        this.install = verifyInstall(this.appDir, this.pack);
        writeJson(path.join(this.outDir, "install.json"), this.install);
        this.check("every installed typescript copy is the package under test", this.install.ok,
            this.install.copies.map((copy) => `${copy.path} ${copy.name}@${copy.version} ${copy.matches ? "match" : "DIFFERENT"}`).join("; "));
        return this.install.ok;
    }

    // Runs a vitest command with a JSON reporter and keeps a per-test pass/fail map.
    async vitest(suite, cmd, args, options = {}) {
        const raw = path.join(this.outDir, "tests", `${suite}.vitest.json`);
        fs.mkdirSync(path.dirname(raw), { recursive: true });
        const step = await this.step(`test-${suite}`, cmd, [
            ...args,
            "--reporter=default",
            "--reporter=json",
            `--outputFile.json=${raw}`,
            "--maxWorkers=4",
        ], options);
        const summary = summarizeVitest(raw, this.appDir);
        this.tests[suite] = { path: `tests/${suite}.json`, ...summary.counts, reportMissing: summary.missing };
        writeJson(path.join(this.outDir, "tests", `${suite}.json`), summary);
        return { step, summary };
    }

    // Starts a long-running command (an app or watch mode) on a free port; `use` gets the
    // service and the base URL. The service is always stopped and its port checked closed.
    async withService(name, cmd, args, { env = {}, ready, readyTimeoutMs = 2 * minute }, use) {
        const port = await freePort();
        const logFile = this.logFile(name);
        const service = startService({
            cmd,
            args,
            cwd: this.appDir,
            env: this.env({ extra: { PORT: String(port), NEST_HARNESS_PORT: String(port), ...env } }),
            logFile,
        });
        const step = {
            name,
            command: [cmd, ...args].join(" "),
            cwd: ".",
            service: true,
            port,
            log: path.relative(this.outDir, logFile),
            required: true,
        };
        this.steps.push(step);
        const base = `http://127.0.0.1:${port}`;
        try {
            if (ready !== undefined) {
                step.readyMs = await service.waitFor(ready, { timeoutMs: readyTimeoutMs });
            }
            await use(service, base);
            step.ok = true;
        } catch (error) {
            step.ok = false;
            step.error = error.message;
        } finally {
            const exit = await service.stop();
            this.lastServiceOutput = service.output;
            step.exitCode = exit.exitCode;
            step.signal = exit.signal;
            step.ms = exit.ms;
            step.portClosed = !(await portIsOpen(port));
            if (!step.portClosed) {
                step.ok = false;
                step.error = `${step.error ?? ""} port ${port} still open after stop`.trim();
            }
        }
        return step;
    }

    async get(base, urlPath, options) {
        return httpRequest(`${base}${urlPath}`, options);
    }

    finish(error) {
        const failedSteps = this.steps.filter((step) => step.required && !step.ok);
        const failedChecks = this.checks.filter((check) => check.severity === "required" && !check.ok);
        let status = failedSteps.length === 0 && failedChecks.length === 0 ? "pass" : "fail";
        if (error !== undefined) {
            status = "error";
            this.notes.push(`harness error: ${error.stack ?? error.message}`);
        }
        const record = {
            id: this.scenario.id,
            letter: this.scenario.letter,
            title: this.scenario.title,
            status,
            startedAt: this.startedAt,
            ms: Date.now() - this.started,
            appDir: this.appDir,
            failedSteps: failedSteps.map((step) => step.name),
            failedChecks: failedChecks.map((check) => check.name),
            steps: this.steps,
            checks: this.checks,
            tests: this.tests,
            artifacts: this.artifacts,
            metrics: this.metrics,
            install: this.install === undefined ? undefined : { ok: this.install.ok, copies: this.install.copies.length, binTsc: this.install.binTsc },
            notes: this.notes,
        };
        writeJson(path.join(this.outDir, "status.json"), record);
        return record;
    }
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

// vitest's JSON report -> { counts, tests: { "<file> > <suite> > <test>": status } }.
function summarizeVitest(rawFile, appDir) {
    if (!fs.existsSync(rawFile)) {
        return { missing: true, counts: { total: 0, passed: 0, failed: 0, skipped: 0 }, tests: {}, failedFiles: [] };
    }
    const report = readJson(rawFile);
    const tests = {};
    const failedFiles = [];
    for (const file of report.testResults ?? []) {
        const rel = path.relative(appDir, file.name).split(path.sep).join("/");
        if (file.status === "failed" && (file.assertionResults ?? []).length === 0) {
            failedFiles.push({ file: rel, message: String(file.message ?? "").slice(0, 2000) });
        }
        for (const assertion of file.assertionResults ?? []) {
            let key = [rel, ...(assertion.ancestorTitles ?? []), assertion.title].join(" > ");
            for (let n = 2; tests[key] !== undefined; n++) {
                key = `${[rel, ...(assertion.ancestorTitles ?? []), assertion.title].join(" > ")} #${n}`;
            }
            tests[key] = normalizeStatus(assertion.status);
        }
    }
    const values = Object.values(tests);
    const counts = {
        total: values.length,
        passed: values.filter((status) => status === "passed").length,
        failed: values.filter((status) => status === "failed").length,
        skipped: values.filter((status) => status === "skipped").length,
        failedFiles: failedFiles.length,
    };
    return { missing: false, counts, tests, failedFiles };
}

function normalizeStatus(status) {
    if (status === "passed" || status === "failed") {
        return status;
    }
    return "skipped";
}
