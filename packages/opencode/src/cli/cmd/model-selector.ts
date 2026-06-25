import { Effect, Console } from "effect"
import { Config } from "../../config/config"
import { effectCmd } from "../effect-cmd"

export const ModelSelectorCommand = effectCmd({
  command: "model-selector <state>",
  describe: "Enable or disable automatic model selection",
  builder: (yargs) => 
    yargs.positional("state", { 
      type: "string",
      choices: ["on", "off"] as const,
      describe: "on | off",
      demandOption: true,
    }),
  instance: false,
  handler: Effect.fn("Cli.modelSelector")(function* (args) {
    const config = yield* Config.Service
    const state = args.state.toLowerCase()
    const enabled = state === "on"
    
    const currentConfig = yield* config.getGlobal()
    const updatedConfig = { ...currentConfig, model_selector_enabled: enabled }
    yield* config.updateGlobal(updatedConfig)

    yield* Console.log(`Automatic model selection ${enabled ? "enabled" : "disabled"}.`)
    yield* Console.log("Changes will apply to new sessions.")
  }),
})
