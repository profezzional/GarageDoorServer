import * as GPIO from 'rpi-gpio';
import { Base } from './base';

// #region Constants
const IS_PI: boolean = require('detect-rpi')();

/**
 * Time it takes the door to go from all the way down to all the way up.
 * Assuming that the door opens slightly slower than it closes, because gravity.
 */
const DOOR_OPEN_TIME_SEC: number = 16.75;
/**
 * Time it takes the door to go from all the way up to all the way down.npm run builkd
 * Assuming that the door closes slightly faster than it opens, because gravity.
 */
const DOOR_CLOSE_TIME_SEC: number = 15.75;
/**
 * Time it takes the opener to actuate after you press the button (i.e. you normally can't just
 * slap the button; you have to actually preeeesss it for a moment).
 * Not sure if this will apply when the opener is actuated electronically, but assuming so for
 * less work late. If it doesn't, can just set this to 0.
 */
const DOOR_OPENER_SIGNAL_HOLD_TIME_SEC: number = 0.25;
const MIN_TIME_BETWEEN_BUTTON_PRESSES_SEC: number = 0.75;

/** The distance the bottom edge of the garage door is off the ground when it's fully open. */
const DOOR_HEIGHT_FEET: number = 7.0833;
/**
 * The maximum height at which the door will automatically go back up when it goes down and touches
 * the floor. 
 * Not sure if mine does this or not, but assuming it does. 
 */
const DOOR_MAX_AUTO_BOUNCE_BACK_HEIGHT_FEET: number = -1; // TODO: measure this
/**
 * The delay between the door going all the way down and the door starting to go back up from
 * bouncing back automatically.
 */
const DOOR_AUTO_BOUNCE_BACK_DELAY_SEC: number = 0.5; // TODO: time this

const OPENER_LIGHT_BUTTON_PRESS_TIME_SEC: number = 0.1; // TODO: time this

/** The computed rate at which the door opens. */
const DOOR_OPEN_RATE_FEET_PER_SEC: number = DOOR_HEIGHT_FEET / DOOR_OPEN_TIME_SEC;
/** The computed rate at which the door closes. */
const DOOR_CLOSE_RATE_FEET_PER_SEC: number = DOOR_HEIGHT_FEET / DOOR_CLOSE_TIME_SEC;

const GPIO_PIN_NUMBER: number = 7;
// #endregion

export type movement = 'up' | 'down' | 'to';

export class GarageDoorHandler extends Base {
    public currentDoorHeight: number = 0;

    private lastDirectionWasUp: boolean = false;
    private doorIsMoving: boolean = false;
    /** Active door-movement timers, used to be able to clear everything in the event of an emergency stop. */
    private timeouts: NodeJS.Timeout[] = [];


    public constructor() {
        super('GarageDoorHandler');

        this.setUpGPIO();
    }

    private setUpGPIO(): void {
        if (!IS_PI) {
            this.log('Not on Pi; simulating GPIO');

            return;
        }

        GPIO.setup(GPIO_PIN_NUMBER, GPIO.DIR_OUT, (error: any): void => {
            if (error) {
                this.log('Error: could not set up pin', GPIO_PIN_NUMBER, '|', error);
                process.exit(1);
            } else {
                this.log('Set up GPIO pin', GPIO_PIN_NUMBER);
                this.turnPinOn();
            }
        });
    }

    public getCurrentDoorHeight(): string {
        switch (this.currentDoorHeight) {
            case 0: return 'closed';
            case DOOR_HEIGHT_FEET: return 'fully open';
            default: return `at ${this.currentDoorHeight} feet`;
        }
    }

    public async stop(): Promise<void> {
        const NUM_DASHES: number = 30;

        this.log('-'.repeat(NUM_DASHES));
        this.log('Emergency stopping door');

        for (const timeout of this.timeouts) {
            clearTimeout(timeout);
        }

        this.timeouts = [];

        if (this.doorIsMoving) {
            await this.pressButton();
            this.log('Pressed button to emergency stop door');
        }

        this.log('Emergency stopped door');
        this.log('-'.repeat(NUM_DASHES));
    }

    public async turnOnLight(): Promise<void> {
        // turn pin off and on quickly to turn the light on but not actuate the motor
        await this.turnPinOff();

        return new Promise((resolve: () => void): void => {
            setTimeout(async (): Promise<void> => {
                await this.turnPinOn();
                resolve();
            }, OPENER_LIGHT_BUTTON_PRESS_TIME_SEC * 1000);
        });
    }

    // #region Request Handling
    public async handleRequest(movement: movement, number: number | null): Promise<void> {
        this.log('----- handling request -----');
        this.log('currentHeight:', this.currentDoorHeight);
        this.log('movement:', movement, '|', 'number:', number);

        if (movement === 'to') {
            await this.handleHeightRequest(movement, number || 0);
        } else {
            await this.handleDistanceRequest(movement, number);
        }
    }

    private async handleDistanceRequest(movement: movement, distance: number | null): Promise<void> {
        const calculatedDistance: number = (distance || DOOR_HEIGHT_FEET) * (movement === 'up' ? 1 : -1);
        await this.handleHeightRequest('to', this.currentDoorHeight + calculatedDistance);
    }

    // #region Height Request
    private async handleHeightRequest(movement: movement, height: number): Promise<void> {
        height = this.correctHeightBounds(height);
        const shouldGoUp: boolean = height > this.currentDoorHeight;
        movement = shouldGoUp ? 'up' : 'down';

        this.log('Moving', movement, 'to', height, 'feet');

        const willBounceBack: boolean =
            this.currentDoorHeight <= DOOR_MAX_AUTO_BOUNCE_BACK_HEIGHT_FEET &&
            this.currentDoorHeight > 0 &&
            !this.lastDirectionWasUp;

        if (willBounceBack) {
            await this.handleBounceBack(shouldGoUp);
        } else {
            await this.conditionallyDoDoublePress(shouldGoUp);
            await this.pressButton();
            this.log('Pressed button to go', movement);
        }

        return new Promise<void>((resolve: () => void): void => {
            this.moveToFinalHeight(height, shouldGoUp, resolve);
        });
    }

    private correctHeightBounds(height: number): number {
        return Math.max(0, Math.min(DOOR_HEIGHT_FEET, height)); // make sure door doesn't go above the door height or below zero
    }

    // #region BounceBack
    private async handleBounceBack(shouldGoUp: boolean): Promise<void> {
        await this.pressButton();
        this.log('Pressed button to make door go down to bounce back up');

        await this.waitForDoorToGetAboveBounceBackHeight();

        if (shouldGoUp) {
            return;
        }

        await this.pressButton();
        this.log('Pressed button to stop door just above bounceback height');

        this.currentDoorHeight += DOOR_OPEN_RATE_FEET_PER_SEC * DOOR_AUTO_BOUNCE_BACK_DELAY_SEC; // account for button-press delay

        await this.pressButton();
        this.log('Pressed button to make door go down');
    }

    private async waitForDoorToGetAboveBounceBackHeight(): Promise<void> {
        const timeToReachBottom: number = this.currentDoorHeight / DOOR_CLOSE_RATE_FEET_PER_SEC;
        const timeToStartGoingUp: number = timeToReachBottom + DOOR_AUTO_BOUNCE_BACK_DELAY_SEC;
        const heightAboveBounceBackHeight: number = DOOR_MAX_AUTO_BOUNCE_BACK_HEIGHT_FEET * 1.1;
        const timeToGetAboveBounceBackHeightSec: number = timeToStartGoingUp + (heightAboveBounceBackHeight / DOOR_OPEN_RATE_FEET_PER_SEC);

        return new Promise<void>((resolve: () => void): void => {
            this.timeouts.push(setTimeout(async (): Promise<void> => {
                this.timeouts.pop();
                this.currentDoorHeight = heightAboveBounceBackHeight;
                resolve();
            }, timeToGetAboveBounceBackHeightSec * 1000));
        });
    }
    // #endregion

    private async conditionallyDoDoublePress(shouldGoUp: boolean): Promise<void> {
        // if the door is partially open and last moved in the desired direction, need to toggle the opener's movement direction by pressing the button twice
        const doDoublePress: boolean =
            this.currentDoorHeight > 0 &&
            this.currentDoorHeight < DOOR_HEIGHT_FEET &&
            shouldGoUp === this.lastDirectionWasUp;

        if (!doDoublePress) {
            return;
        }

        await this.pressButton();
        this.log('Pressed button to toggle opener state');

        const rate: number = shouldGoUp ? DOOR_OPEN_RATE_FEET_PER_SEC : (DOOR_CLOSE_RATE_FEET_PER_SEC * -1);
        this.currentDoorHeight += MIN_TIME_BETWEEN_BUTTON_PRESSES_SEC * rate;

        await this.pressButton();
        this.log('Pressed button to stop door');

        // account for movement in opposite the desired direction while double-pressing
        this.currentDoorHeight += DOOR_OPENER_SIGNAL_HOLD_TIME_SEC * rate;
        this.log('currentHeight after double press:', this.currentDoorHeight);
    }

    private moveToFinalHeight(height: number, shouldGoUp: boolean, resolve: () => void): void {
        const isStoppingEarly: boolean = height < DOOR_HEIGHT_FEET && height > 0;
        const timeToReachHeightSec: number = this.calculateTimeToReachHeight(height, shouldGoUp, isStoppingEarly);

        this.log('moving over', timeToReachHeightSec, 'sec');

        this.timeouts.push(setTimeout(async (): Promise<void> => {
            this.timeouts.pop();

            if (isStoppingEarly) {
                await this.pressButton();
                this.log('Pressed button to stop door');
            }

            this.currentDoorHeight = height;

            this.log('currentHeight after handling:', this.currentDoorHeight);
            this.log('----------------------------');
            resolve();
        }, timeToReachHeightSec * 1000));
    }

    private calculateTimeToReachHeight(height: number, shouldGoUp: boolean, isStoppingEarly: boolean): number {
        const distance: number = Math.abs(height - this.currentDoorHeight);
        const rate: number = shouldGoUp ? DOOR_OPEN_RATE_FEET_PER_SEC : DOOR_CLOSE_RATE_FEET_PER_SEC;

        return (distance / rate) - (isStoppingEarly ? DOOR_OPENER_SIGNAL_HOLD_TIME_SEC : 0);
    }
    // #endregion
    // #endregion

    // #region Button Pressing
    private async pressButton(): Promise<void> {
        this.log('Pressing button...');

        await this.turnPinOff();
        this.log('Turned pin', GPIO_PIN_NUMBER, 'off');

        return new Promise<void>((resolve: () => void): void => {
            setTimeout(async (): Promise<void> => {
                await this.turnPinOn();
                this.log('Turned pin', GPIO_PIN_NUMBER, 'on');

                this.doorIsMoving = !this.doorIsMoving;

                if (this.doorIsMoving) {
                    this.lastDirectionWasUp = !this.lastDirectionWasUp;
                }

                setTimeout((): void => {
                    resolve();
                }, MIN_TIME_BETWEEN_BUTTON_PRESSES_SEC * 1000);
            }, DOOR_OPENER_SIGNAL_HOLD_TIME_SEC * 1000);
        });
    }

    private async turnPinOn(): Promise<void> {
        await this.writePin(true);
    }

    private async turnPinOff(): Promise<void> {
        await this.writePin(false);
    }

    private async writePin(value: boolean): Promise<void> {
        if (IS_PI) {
            return await GPIO.write(GPIO_PIN_NUMBER, value);
        }
    }
    // #endregion
}
