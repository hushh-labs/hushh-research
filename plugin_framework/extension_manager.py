from plugin_loader import load_plugins


def initialize_extensions():

    plugins = load_plugins()

    return {
        "extensions_initialized": True,
        "plugins": plugins
    }