import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createCompilerIO } from "./compiler-host.mjs";

const require = createRequire(import.meta.url);

const inside = (root, file) => {
  const name = relative(root, file);
  return name !== ".." && !name.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(name);
};

const diagnosticText = (ts, diagnostic) => {
  const location = diagnostic.file && diagnostic.start !== undefined
    ? `${diagnostic.file.fileName}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: `
    : "";
  return `${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
};

// a resolver belongs to one analysis run; changing a config cannot reuse a previous run's cache
export const createModuleResolver = (repository, suppliedIO) => {
  const root = resolve(repository);
  const options = new Map();
  const resolutions = new Map();
  let compiler;
  const ts = () => (compiler ??= require("typescript"));
  const io = suppliedIO ?? createCompilerIO(root, {}, ts);
  const optionsFor = (from) => {
    const source = resolve(from);
    if (!inside(root, source)) {
      throw new Error(`Module is outside the project root: ${from}`);
    }
    let folder = dirname(source);
    const visited = [];
    while (inside(root, folder)) {
      if (options.has(folder)) {
        const found = options.get(folder);
        for (const directory of visited) options.set(directory, found);
        return found;
      }
      visited.push(folder);
      const config = join(folder, "tsconfig.json");
      if (io.fileExists(config)) {
        const typescript = ts();
        const read = typescript.readConfigFile(config, io.readFile);
        if (read.error) throw new Error(diagnosticText(typescript, read.error));
        const parsed = typescript.parseJsonConfigFileContent(read.config, io, folder, undefined, config);
        if (parsed.errors.length) {
          throw new Error(parsed.errors.map((error) => diagnosticText(typescript, error)).join("\n"));
        }
        for (const reference of parsed.projectReferences ?? []) {
          const target = reference.path.endsWith(".json") ? reference.path : join(reference.path, "tsconfig.json");
          if (!io.fileExists(target)) throw new Error(`${config}: referenced configuration is missing: ${target}`);
        }
        for (const directory of visited) options.set(directory, parsed.options);
        return parsed.options;
      }
      if (folder === root) break;
      folder = dirname(folder);
    }
    const typescript = ts();
    const defaults = {
      module: typescript.ModuleKind.ESNext,
      moduleResolution: typescript.ModuleResolutionKind.Bundler,
      allowJs: true,
      resolveJsonModule: true,
    };
    for (const directory of visited) options.set(directory, defaults);
    return defaults;
  };
  const resolver = {
    optionsFor,
    isLocal(from, specifier, compilerOptions) {
      if (specifier.startsWith(".") || specifier.startsWith("#") || isAbsolute(specifier)) return true;
      const selected = compilerOptions ?? optionsFor(from);
      return Object.keys(selected.paths ?? {}).some((pattern) => {
        const star = pattern.indexOf("*");
        return star === -1 ? pattern === specifier : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
      });
    },
    resolve(from, specifier, compilerOptions) {
      const typescript = ts();
      const selected = compilerOptions ?? optionsFor(from);
      let cache = resolutions.get(selected);
      if (!cache) {
        cache = typescript.createModuleResolutionCache(root, (file) => typescript.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(), selected);
        resolutions.set(selected, cache);
      }
      const target = typescript.resolveModuleName(specifier, resolve(from), selected, io, cache).resolvedModule;
      return target ? resolve(target.resolvedFileName) : undefined;
    },
    runtime(from, specifier, compilerOptions) {
      const target = resolver.resolve(from, specifier, compilerOptions);
      if (!target || !inside(root, target) || relative(root, target).replaceAll("\\", "/").split("/").includes("node_modules") || !/\.d\.[cm]?ts$/.test(target)) return target;
      const implementation = target.replace(/\.d\.(cts|mts|ts)$/, (_match, extension) => extension === "cts" ? ".cjs" : extension === "mts" ? ".mjs" : ".js");
      return io.fileExists(implementation) ? implementation : undefined;
    },
  };
  return resolver;
};

export const readCompilerOptions = (root, from) => createModuleResolver(root).optionsFor(from);

export const resolveModule = (root, from, specifier, compilerOptions) =>
  createModuleResolver(root).resolve(from, specifier, compilerOptions);
