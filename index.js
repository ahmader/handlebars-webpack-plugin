const fs = require("fs-extra");
const chalk = require("chalk");
const partialUtils = require("./utils/partials");
const helperUtils = require("./utils/helpers");
const Handlebars = require("handlebars");
const glob = require("glob");
const path = require("path");
const log = require("./utils/log");


/**
 * Returns the target filepath of a handlebars template
 * @param  {String} filepath            - input filepath
 * @param  {String} [outputTemplate]    - template for output filename.
 *                                          If ommited, the same filename stripped of its extension will be used
 * @return {String} target filepath
 */
function getTargetFilepath(filepath, outputTemplate) {
    if (outputTemplate == null) {
        return filepath.replace(path.extname(filepath), "");
    }

    const fileName = path
        .basename(filepath)
        .replace(path.extname(filepath), "");
    return outputTemplate.replace("[name]", fileName);
}


class HandlebarsPlugin {

    constructor(options) {
        this.options = Object.assign({
            entry: null,
            output: null,
            data: {},
            helpers: {},
            onBeforeSetup: Function.prototype,
            onBeforeAddPartials: Function.prototype,
            onBeforeCompile: Function.prototype,
            onBeforeRender: Function.prototype,
            onBeforeSave: Function.prototype,
            onDone: Function.prototype
        }, options);

        this.firstCompilation = true;
        this.options.onBeforeSetup(Handlebars);
        this.fileDependencies = [];
        this.assetsToEmit = {};
        this.updateData();

        // register helpers
        const helperMap = helperUtils.resolve(this.options.helpers);
        helperMap.forEach((helper) => {
            helperUtils.register(Handlebars, helper.id, helper.helperFunction);
            this.addDependency(helper.filepath);
        });
    }

    /**
     * Register all partials to Handlebars
     */
    loadPartials() {
        // register partials
        const partials = partialUtils.resolve(Handlebars, this.options.partials);
        this.options.onBeforeAddPartials(Handlebars, partials);
        partialUtils.addMap(Handlebars, partials);
        // watch all partials for changes
        this.addDependency.apply(this, Object.keys(partials).map((key) => partials[key]));
    }

    /**
     * Webpack plugin hook - main entry point
     * @param  {Compiler} compiler
     */
    apply(compiler) {

        // COMPILE TEMPLATES
        compiler.plugin("make", (compilation, done) => {
            if (this.dependenciesUpdated(compilation) === false) {
                return done();
            }

            this.loadPartials(); // Refresh partials
            this.compileAllEntryFiles(compilation.compiler.outputPath, done); // build all html pages
            return undefined;
        });

        // REGISTER FILE DEPENDENCIES TO WEBPACK
        compiler.plugin("emit", (compilation, done) => {
            // register dependencies at webpack
            if (compilation.fileDependencies.add) {
                // webpack@4
                this.fileDependencies.forEach(compilation.fileDependencies.add, compilation.fileDependencies);
            } else {
                compilation.fileDependencies = compilation.fileDependencies.concat(this.fileDependencies);
            }
            // emit generated html pages (webpack-dev-server)
            this.emitGeneratedFiles(compilation);
            return done();
        });
    }

    /**
     * Returns contents of a dependent file
     * @param  {String} filepath
     * @return {String} filecontents
     */
    readFile(filepath) {
        this.fileDependencies.push(filepath);
        return fs.readFileSync(filepath, "utf-8");
    }

    /**
     * Registers a file as a dependency
     * @param {...[String]} args    - list of filepaths
     */
    addDependency(...args) {
        this.fileDependencies.push.apply(this.fileDependencies, args.filter((filename) => filename));
    }

    /**
     * @param  {Object} compilation     - webpack compilation
     * @return {Boolean} true, if a handlebars file or helper has been updated
     */
    dependenciesUpdated(compilation) {
        if (compilation.fileTimestamps.has) { // Map
            // webpack@4.x
            const changedFiles = [];

            const prevTimestamps = this.prevTimestamps || {};
            const currentTimestamps = {};

            compilation.fileTimestamps.forEach((timestamp, watchfile) => {
                currentTimestamps[watchfile] = timestamp;
                if ((prevTimestamps[watchfile] || this.startTime) < (currentTimestamps[watchfile] || Infinity)) {
                    changedFiles.push(watchfile);
                }
            });

            this.prevTimestamps = currentTimestamps;
            return changedFiles.length === 0 || this.containsOwnDependency(changedFiles);
        }

        // webpack@3.x
        const changedFiles = Object.keys(compilation.fileTimestamps).filter((watchfile) =>
            (this.prevTimestamps[watchfile] || this.startTime) < (compilation.fileTimestamps[watchfile] || Infinity)
        );

        return changedFiles.length === 0 || this.containsOwnDependency(changedFiles);
    }

    /**
     * @param  {Array} list     - list of changed files as absolute paths
     * @return {Boolean} true, if a file is a dependency of this handlebars build
     */
    containsOwnDependency(list) {
        for (let i = 0; i < list.length; i += 1) {
            if (this.fileDependencies.includes(list[i])) {
                return true;
            }
        }
        return false;
    }

    /**
     * Register generated html files to support serving file with webpack-dev-server
     * @param  {String} filepath    - target filepath, where the file is created
     * @param  {String} content     - file contents
     */
    registerGeneratedFile(filepath, content) {
        this.assetsToEmit[path.basename(filepath)] = {
            source: () => content,
            size: () => content.length
        };
    }

    /**
     * Resets list of generated files
     */
    clearGeneratedFiles() {
        this.assetsToEmit = {};
    }

    /**
     * Notifies webpack-dev-server of generated files
     * @param  {Compilation} compilation
     */
    emitGeneratedFiles(compilation) {
        Object.keys(this.assetsToEmit).forEach((filename) => {
            compilation.assets[filename] = this.assetsToEmit[filename];
        });
    }

    /**
     * (Re)load input data for hbs rendering
     */
    updateData() {
        if (this.options.data && typeof this.options.data === "string") {
            try {
                const dataFromFile = JSON.parse(this.readFile(this.options.data));
                this.addDependency(this.options.data);
                this.data = dataFromFile;
            } catch (e) {
                console.error(`Tried to read ${this.options.data} as json-file and failed. Using it as data source...`);
                this.data = this.options.data;
            }
        } else {
            this.data = this.options.data;
        }
    }

    /**
     * @async
     * Generates all given handlebars templates
     * @param  {String} outputPath  - webpack output path for build results
     * @param  {Function} done
     */
    compileAllEntryFiles(outputPath, done) {

        this.updateData();

        glob(this.options.entry, (err, entryFilesArray) => {
            if (err) {
                throw err;
            }
            if (entryFilesArray.length === 0) {
                log(chalk.yellow(`no valid entry files found for ${this.options.entry} -- aborting`));
                return;
            }
            entryFilesArray.forEach((filepath) => this.compileEntryFile(filepath, outputPath));
            // enforce new line after plugin has finished
            console.log();

            done();
        });
    }

    /**
     * Generates the html file for the given filepath
     * @param  {String} sourcePath  - filepath to handelebars template
     * @param  {String} outputPath  - webpack output path for build results
     */
    compileEntryFile(sourcePath, outputPath) {
        let targetFilepath = getTargetFilepath(sourcePath, this.options.output);
        // fetch template content
        let templateContent = this.readFile(sourcePath, "utf-8");
        templateContent = this.options.onBeforeCompile(Handlebars, templateContent) || templateContent;
        // create template
        const template = Handlebars.compile(templateContent);
        const data = this.options.onBeforeRender(Handlebars, this.data) || this.data;
        // compile template
        let result = template(data);
        result = this.options.onBeforeSave(Handlebars, result, targetFilepath) || result;

        if (targetFilepath.includes(outputPath)) {
            // change the destination path relative to webpacks output folder and emit it via webpack
            targetFilepath = targetFilepath.replace(outputPath, "").replace(/^\/*/, "");
            this.assetsToEmit[targetFilepath] = {
                source: () => result,
                size: () => result.length
            };

        } else {
            // @legacy: if the filepath lies outside the actual webpack destination folder, simply write that file.
            // There is no wds-support here, because of watched assets being emitted again
            fs.outputFileSync(targetFilepath, result, "utf-8");
        }

        this.options.onDone(Handlebars, targetFilepath);
        log(chalk.grey(`created output '${targetFilepath.replace(`${process.cwd()}/`, "")}'`));
    }
}

// export Handlebars for easy access in helpers
HandlebarsPlugin.Handlebars = Handlebars;

module.exports = HandlebarsPlugin;
