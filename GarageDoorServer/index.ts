import * as BodyParser from 'body-parser';
import * as Express from 'express';
import * as FS from 'fs';
import * as HTTPS from 'https';
import { AddressInfo } from 'net';
import * as ReadLine from 'readline';
import * as Request from 'request';
import * as TorRequest from 'tor-request';
import { Base } from './base';
import { GarageDoorHandler, movement } from './garageDoorHandler';

import ERequest = Express.Request;
import EResponse = Express.Response;
import ENext = Express.NextFunction;

// #region Constants
const HTTPS_PORT: number = 9013;
const DNS_URL: string = process.env.DNS_URL;
const DEFAULT_REQUEST_HEADERS = { 'content-type': 'application/json' };

const SSL_CERT_BASE_PATH: string = '/etc/letsencrypt/live/' + DNS_URL + '/';
const ENCODING: string = 'utf8';
const SSL_PRIVATE_KEY: string = FS.readFileSync(SSL_CERT_BASE_PATH + 'privkey.pem', ENCODING);
const SSL_CERT: string = FS.readFileSync(SSL_CERT_BASE_PATH + 'cert.pem', ENCODING);
const SSL_CHAIN: string = FS.readFileSync(SSL_CERT_BASE_PATH + 'chain.pem', ENCODING);
const SSL_CREDENTIALS = {
    key: SSL_PRIVATE_KEY,
    cert: SSL_CERT,
    ca: SSL_CHAIN
};

const REQUEST_BODY_KEY: string = process.env.REQUEST_BODY_KEY;
const WHOIS_BASE_URL: string = process.env.WHOIS_BASE_URL;
const AWS_ORG_HANDLES: string[] = ['AT-88-Z', 'ADSN-1', 'AMAZO-4'];

const IFTTT_BASE_URL: string = 'https://maker.ifttt.com/trigger/';
const IFTTT_KEY_ROUTE: string = process.env.IFTTT_KEY_ROUTE;

const VALID_MOVEMENTS: movement[] = ['up', 'down', 'to'];

const CHECK_REQUEST_BODY_KEY: boolean = false;
const CHECK_REQUEST_FROM_AWS: boolean = false;
// #endregion

class App extends Base {
    private httpsServer: HTTPS.Server;
    private expressApplication: Express.Application;
    private doorHandler: GarageDoorHandler = new GarageDoorHandler();
    private readlineInterface: ReadLine.Interface = ReadLine.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
    });


    constructor() {
        super('App');

        this.startHTTPSServer();
        this.listenManual();
    }

    private listenManual(): void {
        this.readlineInterface.on('line', (line: string): void => {
            this.doorHandler.handleRequest(line as movement, null);
        });
    }

    // #region HTTPS Server
    private startHTTPSServer(): void {
        this.log('Starting HTTPS server...');

        this.expressApplication = Express();
        this.configureMiddleware();
        this.configureRoutes();

        this.httpsServer = HTTPS.createServer(SSL_CREDENTIALS, this.expressApplication);
        this.httpsServer.on('error', (error: NodeJS.ErrnoException): void => {
            this.onHTTPServerError(error, HTTPS_PORT);
        });
        this.httpsServer.listen(HTTPS_PORT, (): void => {
            this.log('HTTPS server listening on port', (<AddressInfo>this.httpsServer.address()).port);
        });
    }

    // #region Middleware
    private configureMiddleware(): void {
        this.expressApplication.use(this.logRequest);
        this.expressApplication.use(this.bodyParserJSON);
        this.expressApplication.use(this.validateRequest);
    }

    private logRequest(request: ERequest | any, response: EResponse = null, next: ENext = null): void {
        const sourceIP: string = this.getSourceIP(request.connection.remoteAddress);
        this.log('Received', ...this.getRequestInfo(request, sourceIP));

        if (next) {
            next();
        }
    }

    private bodyParserJSON(request: ERequest, response: EResponse, next: ENext): void {
        const options: BodyParser.OptionsJson = {
            verify: (request: ERequest, response: EResponse, buffer: Buffer): void => {
                request['rawBody'] = buffer.toString();
            },
        };

        BodyParser.json(options)(request, response, (error: Error): void => {
            if (error) {
                response.sendStatus(404);

                return;
            }

            next();
        });
    }

    // #region Request Validation
    private validateRequest(request: ERequest, response: EResponse, next: ENext): void {
        const sourceIP: string = this.getSourceIP(request.connection.remoteAddress);

        if (!CHECK_REQUEST_BODY_KEY || request.body.key === REQUEST_BODY_KEY) {
            if (CHECK_REQUEST_FROM_AWS) {
                this.checkAWS(sourceIP).then((): void => {
                    this.allowRequest(request, sourceIP, next);
                }).catch(async (reason: any): Promise<void> => {
                    this.denyRequest(request, response, sourceIP, reason); // deny non-AWS requests
                });
            } else {
                this.allowRequest(request, sourceIP, next);
            }
        } else {
            // deny requests with wrong key
            this.denyRequest(request, response, sourceIP, 'invalid key "' + request.body.key + '"');
        }
    }

    private getSourceIP(remoteAddress: string): string {
        const fIndex: number = remoteAddress.indexOf('f:');

        return remoteAddress.substring(fIndex < 0 ? 0 : fIndex + 2);
    }

    private allowRequest(request: ERequest, sourceIP: string, next: ENext): void {
        this.log('Allowed', ...this.getRequestInfo(request, sourceIP));
        next();
    }

    private async denyRequest(request: ERequest, response: EResponse, sourceIP: string, error: any): Promise<void> {
        this.log('Denied', ...this.getRequestInfo(request, sourceIP, (error ? `| ${App.toString(error)}` : '')));
        await this.sendErrorNotificationToIFTTT(error);
        response.sendStatus(404);
    }

    private getRequestInfo(request: ERequest, sourceIP: string, ...extraInfo: any[]): string[] {
        return [
            request.protocol,
            request.method,
            'request for port',
            (<AddressInfo>request.socket.address()).port,
            `on route "${request.url}"`,
            'from IP',
            `\"${sourceIP}\"`,
            ...extraInfo
        ];
    }

    // #region Check AWS 
    private async checkAWS(sourceIP: string): Promise<void> {
        return new Promise((resolve: () => void, reject: (reason: any) => void): void => {
            TorRequest.request.get({
                headers: DEFAULT_REQUEST_HEADERS,
                url: WHOIS_BASE_URL + sourceIP
            }, (error: any, checkResponse: Request.Response): void => {
                if (checkResponse) {
                    error = error || this.checkOrgHandle(checkResponse.body);

                    if (error) {
                        reject(error);
                    } else {
                        resolve(); // no error, so org-handle check passed
                    }
                } else {
                    reject('no response received from ensuring request is from AWS');
                }
            });
        });
    }

    private checkOrgHandle(body: string): any {
        const error: string = 'could not verify request is from from AWS | ';

        try {
            const orgHandle: string = this.getOrgHandle(body);

            if (orgHandle) {
                if (AWS_ORG_HANDLES.includes(orgHandle)) {
                    return null; // probably from IFTTT, so let it through
                }

                return `${error}org handle "${orgHandle}" is not AWS`;
            }

            return `${error}could not parse org handle`;
        } catch (innerError) {
            return error + JSON.stringify(innerError);
        }
    }

    private getOrgHandle(body: string): string {
        const orgHandleLabelIndex: number = body.indexOf('Org Handle:');

        if (orgHandleLabelIndex < 0) {
            return null;
        }

        const orgHandleStartIndex: number = body.indexOf('"value">', orgHandleLabelIndex) + 8;
        const orgHandleEndIndex: number = body.indexOf('<', orgHandleStartIndex);
        const orgHandle: string = body.substring(orgHandleStartIndex, orgHandleEndIndex);

        return orgHandle;
    }
    // #endregion
    // #endregion
    // #endregion

    private configureRoutes(): void {
        const router: Express.Router = Express.Router();

        //router.get('/.well-known/acme-challenge/:key', (request: ERequest, response: EResponse): void => {
        //    response.sendFile('../' + request.params.key);
        //});
        router.get('/garageDoor', (request: ERequest, response: EResponse): void => {
            this.sendDoorCurrentHeightToIFTTT().catch((error: any): void => {
                this.onError(error);
            });

            response.sendStatus(200);
        });
        router.post('/garageDoor/:movement', (request: ERequest, response: EResponse): void => {
            this.handleRequest(request, response);
        });
        router.post('/garageDoor/:movement/:distance', (request: ERequest, response: EResponse): void => {
            this.handleRequest(request, response);
        });
        router.post('/garageDoor/stop', (request: ERequest, response: EResponse): void => {
            this.doorHandler.stop().then((): void => {
                this.doorHandler = new GarageDoorHandler();
            }).catch((error: any): void => {
                this.onError(error);
            });

            response.sendStatus(200);
        });
        router.post('/garageDoor/light', (request: ERequest, response: EResponse): void => {
            this.doorHandler.turnOnLight().catch((error: any): void => {
                this.onError(error);
            });
            response.sendStatus(200);
        });
        router.all('*', this.rejectWildcardRouteRequest);

        this.expressApplication.use('/', router);
    }

    private rejectWildcardRouteRequest(request: ERequest, response: EResponse): void {
        const sourceIP: string = this.getSourceIP(request.connection.remoteAddress);
        const error: string = [
            'Rejected',
            ...this.getRequestInfo(request, sourceIP),
            '| nonexistent request-method/route combo'
        ].join(' ');

        this.log(error);
        this.sendErrorNotificationToIFTTT(error);
        response.sendStatus(404); // sort of hide server existence by not sending a response
    }

    private handleRequest(request: ERequest, response: EResponse): void {
        const movement: movement = request.params.movement;
        let error: string = null;

        if (VALID_MOVEMENTS.includes(movement)) {
            const distance: number = parseFloat(request.params.distance);

            if (!Boolean(request.params.distance) || (typeof distance === 'number' && distance >= 0)) {
                this.doorHandler.handleRequest(movement, distance).then((): void => {
                    this.sendDoorCurrentHeightToIFTTT();
                }).catch((error: any): void => {
                    this.onError(error);
                });

                response.sendStatus(200);
            } else {
                error = `invalid distance "${distance}"`;
            }
        } else {
            error = 'invalid movement type "' + movement + '"';
        }

        if (error) {
            this.log(error);
            this.sendErrorNotificationToIFTTT(error);
            response.sendStatus(404); // sort of hide server existence by sending a 404 if invalid route params
        }
    }

    // #region IFTTT Posts
    private async sendDoorCurrentHeightToIFTTT(): Promise<void> {
        await this.postToIFTTT('garage_door_current_height', this.doorHandler.getCurrentDoorHeight()).catch((error: any): void => {
            this.onError(error);
        });
    }

    private async sendErrorNotificationToIFTTT(error: string): Promise<void> {
        await this.postToIFTTT('error_notification', 'Garage Door', error).catch(); // empty catch to hide error if can't post error to IFTTT
    }

    private async postToIFTTT(eventName: string, value1: any, value2: any = undefined): Promise<void> {
        this.log('Posting event "' + eventName + '" to IFTTT');

        return new Promise<void>((resolve: () => void): void => {
            Request.post({
                headers: DEFAULT_REQUEST_HEADERS,
                url: IFTTT_BASE_URL + eventName + IFTTT_KEY_ROUTE,
                body: JSON.stringify({ value1: App.toString(value1), value2: App.toString(value2) })
            }, (error: any, response: Request.Response): void => {
                if (!Boolean(error)) {
                    if (response.statusCode === 200) {
                        this.log(`Posted event "${eventName}" to IFTTT`);

                        return resolve();
                    }

                    error = ` received response status code ${response.statusCode}`;
                }

                error = `Error: could not post event "${eventName}" to IFTTT | ${App.toString(error)}`;
                this.log(error);
                resolve();
            });
        });
    }
    // #endregion

    private onHTTPServerError(error: NodeJS.ErrnoException, port: number): void {
        if (error.syscall === 'listen') {
            switch (error.code) {
                case 'EACCES':
                    this.log('Error: port', port, 'requires elevated privileges');
                    break;
                case 'EADDRINUSE':
                    this.log('Error: port', port, 'is already in use');
                    break;
                default:
                    this.log(error);
                    break;
            }
        } else {
            this.log('Error:', error);
        }

        process.exit(1);
    }
    // #endregion

    private static toString(value: any): string {
        switch (typeof value) {
            case 'object': return JSON.stringify(value);
            case 'string': return value;
            default: return value + '';
        }
    }

    private onError(error: any): void {
        this.log(error);
        this.sendErrorNotificationToIFTTT(error);
    }
}

const app: App = new App(); // start the app
