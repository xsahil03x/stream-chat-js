import uuidv4 from 'uuid/v4';

import {
	createUsers,
	createUserToken,
	expectHTTPErrorCode,
	getTestClient,
	getTestClientForUser,
	getServerTestClient,
	sleep,
	createEventWaiter,
} from './utils';

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

const expect = chai.expect;

chai.use(chaiAsPromised);

if (process.env.NODE_ENV !== 'production') {
	require('longjohn');
}

const Promise = require('bluebird');
Promise.config({
	longStackTraces: true,
	warnings: {
		wForgottenReturn: false,
	},
});

describe.only('static location sharing', function() {
	let client1;
	let client2;
	let channel1;
	let channel2;
	const userID1 = uuidv4();
	const userID2 = uuidv4();

	before(async function() {
		await createUsers([userID1, userID2]);
		client1 = await getTestClientForUser(userID1);
		client2 = await getTestClientForUser(userID2);
	});

	const locationAttachment = {
		type: 'location',
		location: {
			lat: 44.2,
			lon: 22.1,
			accuracy: 0,
		},
	};

	it('user1 creates a channel', async function() {
		channel1 = client1.channel('messaging', uuidv4(), {
			members: [userID1, userID2],
		});
		await channel1.create();
	});

	let messageEventPromise;

	it('user2 joins the channel', async function() {
		channel2 = client2.channel('messaging', channel1.id);
		messageEventPromise = new Promise((resolve, reject) => {
			channel2.on(event => {
				if (event.type == 'message.new') {
					resolve(event);
				}
			});
		});
		await channel2.watch();
	});

	it('user1 sends a message with a static location', async function() {
		const message = {
			text: "Here's the location of the building.",
			attachments: [locationAttachment],
		};

		const resp = await channel1.sendMessage(message);

		expect(resp.message).to.include({
			text: "Here's the location of the building.",
		});

		expect(resp.message.attachments).to.eql([locationAttachment]);
	});

	it('user2 receives the message', async function() {
		const evt = await messageEventPromise;

		expect(evt.message).to.include({
			text: "Here's the location of the building.",
		});

		expect(evt.message.attachments).to.eql([locationAttachment]);
	});

	it('user sends invalid latitude', async function() {
		const msg = {
			text: "Here's the location of the building.",
			attachments: [
				{
					type: 'location',
					location: {
						lat: 91,
						lon: 22.1,
						accuracy: 0,
					},
				},
			],
		};
		await expectHTTPErrorCode(400, channel1.sendMessage(msg));
	});

	it('user sends invalid longitude', async function() {
		const msg = {
			text: "Here's the location of the building.",
			attachments: [
				{
					type: 'location',
					location: {
						lat: 0,
						lon: 181.1,
						accuracy: 0,
					},
				},
			],
		};
		await expectHTTPErrorCode(400, channel1.sendMessage(msg));
	});

	it('user sends invalid accuracy', async function() {
		const msg = {
			text: "Here's the location of the building.",
			attachments: [
				{
					type: 'location',
					location: {
						lat: 0,
						lon: 0,
						accuracy: 2000,
					},
				},
			],
		};
		await expectHTTPErrorCode(400, channel1.sendMessage(msg));
	});
});
