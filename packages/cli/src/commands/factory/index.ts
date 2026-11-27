import { Command } from "commander";
import { createFactoryMachineIdentityCommand } from "./machine-identity.js";
import { createFactoryProjectCommand } from "./project.js";

export function createFactoryCommand(): Command {
  return new Command("factory")
    .description("Manage a project's Factory")
    .addCommand(createFactoryProjectCommand())
    .addCommand(createFactoryMachineIdentityCommand());
}
