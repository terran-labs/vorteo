import { Command } from "commander";
import { createFactoryProjectCommand } from "./project.js";

export function createFactoryCommand(): Command {
  return new Command("factory")
    .description("Manage a project's Factory")
    .addCommand(createFactoryProjectCommand());
}
