const Promise = require('bluebird');
const { MongoClient } = require('mongodb');
const fs = require('fs');

const DriverBase = require('../driver-base');
const { logInfo } = require('../../utils/logger');
const Spinner = require('../../utils/spinner');
const { FORMATS } = require('../../constants');
const { backupParsersOptions, restoreParsersOptions } = require('./parsers');

Promise.promisifyAll(MongoClient);
const systemRegex = /^.*system\..*$/;
const connectionOptions = {
    useNewUrlParser: true
};

class MongoDBDriver extends DriverBase {

    constructor(config) {
        super(config);
    }

    validateConnection() {
        super.validateConnection();

        return MongoClient.connect(this.uri, connectionOptions);
    }

    doBackup() {
        super.doBackup();

        const doBackupPromise = new Promise((resolve, reject) => {
            MongoClient.connect(this.uri, connectionOptions, async (err, client) => {
                try {
                    const db = client.db(this.database);
                    let collections = await db.collections();

                    if (collections.length === 0) {
                        reject('Database is empty');
                        return;
                    }

                    const backupFolder = await this._backupCollections(db);
                    resolve(backupFolder);
                } catch (err) {
                    reject(err);
                }
            });
        });

        return doBackupPromise
            .then(backupFolder => `Backup is ready. Path to backup is ${backupFolder}.`)
            .catch(err => `Error while backing up database. ${err}`);
    }

    doRestore() {
        super.doRestore();

        const doRestorePromise = new Promise((resolve, reject) => {
            MongoClient.connect(this.uri, { useNewUrlParser: true }, async (err, client) => {
                try {
                    const db = client.db(this.database);
                    let files = fs.readdirSync(this.path);

                    if (files.length === 0) {
                        reject('Files are not fould in backup folder');
                        return;
                    }

                    await this._dropCollections(db);
                    await this._restoreCollections(db);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });

        return doRestorePromise
            .then(() => 'Database restored')
            .catch(err => `Error while restoring database. ${err}`);
    }

    async _backupCollections(db) {
        let collections = await db.collections();
        const parserOptions = backupParsersOptions[this.format];
        const backupFolder = `${this.path}${new Date().getTime()}_${this.database}`;
        fs.mkdirSync(backupFolder);

        while (collections.length !== 0) {
            const collection = collections.shift();

            if (!this._systemCollection(collection.collectionName)) { //TODO : backup and restore system collection
                const fileName = `${backupFolder}/${collection.collectionName}.${this.format}`;
                await this._backupCollection(collection, fileName, parserOptions);
            }
        }
        return backupFolder;
    }

    async _backupCollection(collection, fileName, backupOptions) {
        const { transform, pipe } = backupOptions;
        const { collectionName } = collection;

        return new Promise((resolve, reject) => {
            const spinner = new Spinner(`Backing up ${collection.collectionName} ...`);
            spinner.run();

            const writeStream = fs.createWriteStream(fileName);
            const readStream = collection.find().stream({ transform });
            readStream.
                on('error', error => {
                    spinner.stop();
                    reject(`Can't back up ${collectionName}. ${error.message}`);
                }).
                on('end', () => {
                    spinner.stop();
                    resolve();
                });

            pipe(readStream, writeStream);
        });
    }

    async _restoreCollections(db) {
        let files = fs.readdirSync(this.path);

        while (files.length !== 0) {
            const file = files.shift();
            const dataFormat = this._getDataFormat(file);

            if (!dataFormat) {
                logInfo(`Can't read ${file}. Supported files : ${Object.values(FORMATS).join(',')}`);
                continue;
            }

            //TODO : restore system collections and indexes 
            const collectionName = file.replace(`.${dataFormat}`, '');
            const collection = await db.createCollection(collectionName);
            const results = await this._restoreCollection(collection, `${this.path}${file}`, dataFormat);

            if (results) {
                logInfo(`Inserted ${results.insertedCount} records. ${results.result.writeErrors.length + results.result.writeConcernErrors.length} errors`);
            }
        }
    }

    async _restoreCollection(collection, filePath, dataFormat) {
        const parserOptions = restoreParsersOptions[dataFormat];

        return new Promise(async (resolve, reject) => {
            const spinner = new Spinner(`Restoring ${collection.collectionName}`);
            spinner.run();

            const readStream = fs.createReadStream(filePath);
            readStream.on('error', error => {
                spinner.stop();
                reject(`Can't restore ${collection.collectionName}. ${error.message}`);
            });

            const documents = await parserOptions.readData(readStream);
            const results = await collection.bulkWrite(documents.map(document => (
                {
                    'insertOne': {
                        'document': document
                    }
                }
            )));
            spinner.stop();
            resolve(results);
        });
    }

    _dropCollections(db) {
        db.collections().then(async collections => {
            collections.forEach(async collection => {
                if (!this._systemCollection(collection.collectionName)) {
                    await collection.drop();
                }
            });
        });
    }

    _getDataFormat(fileName) {
        return Object.values(FORMATS).reduce((dataFormat, key) => {
            if (fileName.endsWith(`.${key}`)) {
                dataFormat = key;
            }
            return dataFormat;
        }, null);
    }

    _systemIndexesCollection(collectionName) {
        return collectionName.includes('system.indexes');
    }

    _systemCollection(collectionName) {
        return systemRegex.test(collectionName);
    }
}

module.exports = MongoDBDriver;