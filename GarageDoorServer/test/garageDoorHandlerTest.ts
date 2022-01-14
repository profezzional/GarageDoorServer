import * as assert from 'assert';
import { Base } from '../base';
import { GarageDoorHandler, movement } from '../garageDoorHandler';

const DOOR_HEIGHT_FEET: number = 7.5;

// NOTE: non-arrow functions used so that can change mocha test timeout
// NOTE: test names start with number to enforce order in Test Explorer

const garageDoorHandler: GarageDoorHandler = new GarageDoorHandler();
const runTest: (direction: movement, distance: number, expectedHeight: number) => Promise<void> = (direction: movement, distance: number, expectedHeight: number): Promise<void> => {
    return garageDoorHandler.handleRequest(direction, distance).then((): void => {
        assert.equal(garageDoorHandler.currentDoorHeight, expectedHeight);
    });
};

const itShould: (testName: string, direction: movement, distance: number, expectedHeight: number) => void = (testName: string, direction: movement, distance: number, expectedHeight: number): void => {
    it(testName, (): Promise<void> => {
        return runTest(direction, distance, expectedHeight);
    });
};


describe('Random-Number Tests', function () {
    this.timeout(30000);

    const NUM_TESTS: number = 100;

    for (let i: number = 0; i < NUM_TESTS; i++) {
        const expectedHeight: number = Base.round(Math.random() * DOOR_HEIGHT_FEET, 1);

        itShould(`${i + 1}) Should be ${expectedHeight} feet up`, 'to', expectedHeight, expectedHeight);
    }
});

describe('Bounceback Tests', function () {
    this.timeout(30000);

    const testHeights: number[] = [1.5, 0.75, 0.25, 0.75, 1.5, 2, 1.5, 0, 0.25];

    for (let i: number = 0; i < testHeights.length; i++) {
        it((i + 1) + ') Should be ' + testHeights[i] + ' feet up', (): Promise<void> => { return runTest('to', testHeights[i], testHeights[i]); });
    }
});

describe('Distance Tests', function () {
    this.timeout(30000);

    itShould('1) Should go all the way up', 'up', null, DOOR_HEIGHT_FEET);
    itShould('2) Should go all the way down', 'down', null, 0);
    itShould('3) Should go halfway up', 'up', DOOR_HEIGHT_FEET / 2, DOOR_HEIGHT_FEET / 2);
    itShould('4) Should go the rest of the way up', 'up', DOOR_HEIGHT_FEET / 2, DOOR_HEIGHT_FEET);
    itShould('5) Should go 3 feet down', 'down', 3, DOOR_HEIGHT_FEET - 3);
    itShould('6) Should go 3 feet down', 'down', 3, DOOR_HEIGHT_FEET - 6);
    itShould('7) Should go 1.5 feet down', 'down', 3, 0);
    itShould('8) Should go 7.5 feet up', 'up', DOOR_HEIGHT_FEET + 1, DOOR_HEIGHT_FEET);
});

describe('Height Tests', function () {
    this.timeout(30000);

    itShould('1) Should be all the way up', 'to', 8, DOOR_HEIGHT_FEET);
    itShould('2) Should be all the way down', 'to', -1, 0);
    itShould('3) Should be halfway up', 'to', DOOR_HEIGHT_FEET / 2, DOOR_HEIGHT_FEET / 2);
    itShould('4) Should be the rest of the way up', 'to', DOOR_HEIGHT_FEET, DOOR_HEIGHT_FEET);
    itShould('5) Should be at 3 feet from the top', 'to', DOOR_HEIGHT_FEET - 3, DOOR_HEIGHT_FEET - 3);
    itShould('6) Should be at 6 feet down', 'to', DOOR_HEIGHT_FEET - 6, DOOR_HEIGHT_FEET - 6);
    itShould('7) Should be all the way down', 'to', 0, 0);
    itShould('8) Should be all the way up', 'to', DOOR_HEIGHT_FEET, DOOR_HEIGHT_FEET);
});
