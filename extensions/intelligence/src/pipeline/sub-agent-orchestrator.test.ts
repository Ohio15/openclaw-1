import { describe, it, expect } from "vitest";
import { SubAgentOrchestrator } from "./sub-agent-orchestrator.js";
import type { SubTask } from "./sub-agent-orchestrator.js";

describe("SubAgentOrchestrator", () => {
  const orchestrator = new SubAgentOrchestrator();

  function makeTask(overrides: Partial<SubTask> & { name: string }): SubTask {
    return {
      description: `Description for ${overrides.name}`,
      priority: 1,
      dependencies: [],
      ...overrides,
    };
  }

  describe("buildChainedPrompt", () => {
    const singleTask: SubTask[] = [
      makeTask({ name: "Analyze", description: "Analyze the data" }),
    ];

    const multiTasks: SubTask[] = [
      makeTask({ name: "Research", description: "Gather information" }),
      makeTask({ name: "Analyze", description: "Analyze findings" }),
      makeTask({
        name: "Synthesize",
        description: "Combine results",
        dependencies: ["Research", "Analyze"],
      }),
    ];

    it("includes the multi-step task execution heading", () => {
      const result = orchestrator.buildChainedPrompt(singleTask, null);
      expect(result).toContain("## Multi-Step Task Execution");
    });

    it("includes step headings for each task", () => {
      const result = orchestrator.buildChainedPrompt(multiTasks, null);
      expect(result).toContain("### Step 1: Research");
      expect(result).toContain("### Step 2: Analyze");
      expect(result).toContain("### Step 3: Synthesize");
    });

    it("includes task descriptions in the output", () => {
      const result = orchestrator.buildChainedPrompt(multiTasks, null);
      expect(result).toContain("Gather information");
      expect(result).toContain("Analyze findings");
      expect(result).toContain("Combine results");
    });

    it("includes dependency references when a task has explicit dependencies", () => {
      const result = orchestrator.buildChainedPrompt(multiTasks, null);
      expect(result).toContain(
        "Consider the output from the following prior step(s) when completing this step: Research, Analyze."
      );
    });

    it("references prior step output for non-first tasks without explicit dependencies", () => {
      const tasks: SubTask[] = [
        makeTask({ name: "First", description: "Do first thing" }),
        makeTask({ name: "Second", description: "Do second thing" }),
      ];
      const result = orchestrator.buildChainedPrompt(tasks, null);
      expect(result).toContain(
        "Consider the output from Step 1 when completing this step."
      );
    });

    it("does not include a dependency reference for the first task with no dependencies", () => {
      const result = orchestrator.buildChainedPrompt(multiTasks, null);
      const step1Section = result.split("### Step 2")[0];
      expect(step1Section).not.toContain("Consider the output from");
    });

    it("includes step tag instructions for each task", () => {
      const result = orchestrator.buildChainedPrompt(multiTasks, null);
      expect(result).toContain(
        "Output your work for this step between <step-1> and </step-1> tags."
      );
      expect(result).toContain(
        "Output your work for this step between <step-2> and </step-2> tags."
      );
      expect(result).toContain(
        "Output your work for this step between <step-3> and </step-3> tags."
      );
    });

    it("includes domain context section when domainContext is provided", () => {
      const result = orchestrator.buildChainedPrompt(
        singleTask,
        "This is about quantum physics."
      );
      expect(result).toContain("### Domain Context");
      expect(result).toContain("This is about quantum physics.");
    });

    it("omits domain context section when domainContext is null", () => {
      const result = orchestrator.buildChainedPrompt(singleTask, null);
      expect(result).not.toContain("### Domain Context");
    });

    it("includes final integration section with final tags", () => {
      const result = orchestrator.buildChainedPrompt(singleTask, null);
      expect(result).toContain("### Final Integration");
      expect(result).toContain("<final>");
      expect(result).toContain("</final>");
    });

    it("handles an empty subTasks array with only header and final integration", () => {
      const result = orchestrator.buildChainedPrompt([], null);
      expect(result).toContain("## Multi-Step Task Execution");
      expect(result).toContain("### Final Integration");
      expect(result).not.toMatch(/### Step/);
    });
  });

  describe("extractSubTaskOutputs", () => {
    it("extracts a single step output", () => {
      const response = "<step-1>Hello world</step-1>";
      const outputs = orchestrator.extractSubTaskOutputs(response);
      expect(outputs.get("step-1")).toBe("Hello world");
    });

    it("extracts multiple step outputs", () => {
      const response = [
        "<step-1>First result</step-1>",
        "<step-2>Second result</step-2>",
        "<step-3>Third result</step-3>",
      ].join("\n");
      const outputs = orchestrator.extractSubTaskOutputs(response);
      expect(outputs.get("step-1")).toBe("First result");
      expect(outputs.get("step-2")).toBe("Second result");
      expect(outputs.get("step-3")).toBe("Third result");
      expect(outputs.size).toBe(3);
    });

    it("extracts final tag content", () => {
      const response =
        "<step-1>Work</step-1>\n<final>The integrated answer.</final>";
      const outputs = orchestrator.extractSubTaskOutputs(response);
      expect(outputs.get("final")).toBe("The integrated answer.");
    });

    it("returns an empty map when response contains no tags", () => {
      const response = "This is just plain text with no tags at all.";
      const outputs = orchestrator.extractSubTaskOutputs(response);
      expect(outputs.size).toBe(0);
    });

    it("handles multiline content within tags", () => {
      const response = [
        "<step-1>",
        "Line one",
        "Line two",
        "Line three",
        "</step-1>",
      ].join("\n");
      const outputs = orchestrator.extractSubTaskOutputs(response);
      expect(outputs.get("step-1")).toBe("Line one\nLine two\nLine three");
    });

    it("trims whitespace from extracted content", () => {
      const response = "<step-1>   padded content   </step-1>";
      const outputs = orchestrator.extractSubTaskOutputs(response);
      expect(outputs.get("step-1")).toBe("padded content");
    });
  });
});
