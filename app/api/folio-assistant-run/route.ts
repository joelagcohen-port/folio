import { createAssistantTaskRunnerHandler } from "../../folio-assistant-task-runner.ts";

export const runtime = "nodejs";

export const POST = createAssistantTaskRunnerHandler({ fetch, env: process.env });

