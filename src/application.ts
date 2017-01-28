import * as Rx from 'rxjs/Rx';
import * as glob from 'glob';
import * as minimatch from 'minimatch';
import * as cspell from './index';
import * as fsp from 'fs-promise';
import * as path from 'path';

// cspell:word nocase

export interface CSpellApplicationOptions {
    verbose: boolean;
    config?: string;
    exclude?: string;
}

export interface AppError extends NodeJS.ErrnoException {};

export interface RunResult {
    files: number;
    issues: number;
}

export class CSpellApplication {

    readonly info: (message?: any, ...args: any[]) => void;
    private configGlob = 'cspell.json';
    private configGlobOptions: minimatch.IOptions = { nocase: true };
    private excludeGlobs = [
        'node_modules/**'
    ];
    private excludes: RegExp[];

    constructor(readonly files: string[], readonly options: CSpellApplicationOptions, readonly log: (message?: any, ...args: any[]) => void) {
        this.info              = options.verbose ? log : () => {};
        this.configGlob        = options.config || this.configGlob;
        this.configGlobOptions = options.config ? {} : this.configGlobOptions;
        const excludes         = options.exclude && options.exclude.split(/\s+/g);
        this.excludeGlobs      = excludes || this.excludeGlobs;
        this.excludes          = this.excludeGlobs.map(glob => minimatch.makeRe(glob));
    }

    run(): Promise<RunResult> {

        this.header();
        const globRx: GlobRx = Rx.Observable.bindNodeCallback<string, string[]>(glob);

        const processed = new Set<string>();

        const configRx = globRx(this.configGlob, this.configGlobOptions)
            .do(configFiles => this.info(`Config Files Found:\n    ${configFiles.join('')}\n`))
            .map(filenames => cspell.readSettingsFiles(filenames));

        interface FileInfo {
            filename: string;
            text: string;
        }

        const filesRx: Rx.Observable<FileInfo> = Rx.Observable.from(this.files)
            .flatMap(pattern => globRx(pattern)
                .catch((error: AppError) => {
                    return new Promise<string[]>((resolve) => resolve(Promise.reject({...error, message: 'Error with glob search.'})));
            }))
            .flatMap(a => a)
            .filter(filename => !processed.has(filename))
            .do(filename => processed.add(filename))
            .filter(filename => !this.isExcluded(filename))
            .flatMap(filename => {
                return fsp.readFile(filename).then(
                    text => ({text: text.toString(), filename}),
                    error => {
                        return error.code === 'EISDIR'
                            ? Promise.resolve()
                            : Promise.reject({...error, message: `Error reading file: "${filename}"`});
                    });
            })
            .filter(a => !!a);

        const status: RunResult = {
            files: 0,
            issues: 0,
        };

        const r = Rx.Observable.combineLatest(
                configRx,
                filesRx,
                (config, fileInfo) => ({ config, text: fileInfo.text, filename: fileInfo.filename })
            )
            .do(() => status.files += 1)
            .flatMap(({config, filename, text}) => {
                const ext = path.extname(filename);
                const languageIds = cspell.getLanguagesForExt(ext);
                const settings = cspell.mergeSettings(cspell.getDefaultSettings(), config);
                const fileSettings = cspell.constructSettingsForText(settings, text, languageIds);
                return cspell.validateText(text, fileSettings)
                    .then(wordOffsets => {
                        return {
                            filename,
                            issues: cspell.Text.calculateTextDocumentOffsets(filename, text, wordOffsets)
                        };
                    });
            })
            .do(info => {
                const {filename, issues} = info;
                this.info(`Checking: ${filename} ... Issues: ${issues.length}`);
                issues
                    .map(({uri, row, col, word}) => `${uri}[${row}, ${col}]: Unknown word: ${word}`)
                    .forEach(message => this.log(message));
            })
            .filter(info => !!info.issues.length)
            .reduce((status, info) => ({...status, issues: status.issues + info.issues.length}), status)
            .toPromise();
        return r;
    }

    protected header() {
        this.info(`
cspell;
Date: ${(new Date()).toUTCString()}
Options:
    verbose: ${yesNo(this.options.verbose)}
    config:  ${this.configGlob}
    exclude: ${this.excludeGlobs.join('\n             ')}
    files:   ${this.files}
`);
    }


    protected isExcluded(filename: string) {
        const cwd = process.cwd();
        const relFilename = (filename.slice(0, cwd.length) === cwd) ? filename.slice(cwd.length) : filename;

        for (const reg of this.excludes) {
            if (reg.test(relFilename)) {
                return true;
            }
        }
        return false;
    }
}

type GlobRx = (filename: string, options?: minimatch.IOptions) => Rx.Observable<string[]>;


function yesNo(value: boolean) {
    return value ? 'Yes' : 'No';
}