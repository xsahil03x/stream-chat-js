import { getTestClient, getTestClientForUser, sleep } from './utils';
import { v4 as uuidv4 } from 'uuid';
import chai from 'chai';
const expect = chai.expect;

const locationChan = 'location-sharing-channel';

function equalLocationInAttachment(msg, loc) {
	expect(msg).not.to.be.empty;
	expect(msg.id).not.to.be.empty;
	expect(msg.attachments).to.have.lengthOf(1);
	expect(msg.attachments[0].type).to.equal('location');
	expect(msg.attachments[0].location).to.not.be.empty;
	expect(msg.attachments[0].location.lat).to.equal(loc.lat);
	expect(msg.attachments[0].location.lon).to.equal(loc.lon);
	expect(msg.attachments[0].location.accuracy).to.equal(loc.accuracy);
	expect(msg.attachments[0].location.live).to.equal(
		loc.live !== undefined ? loc.live : false,
	);
}

describe('Location sharing', function () {
	let alice, bob, client, bobClient, channel, serverClient;

	before(async () => {
		alice = { id: `alice-${uuidv4()}`, role: 'admin' };
		bob = { id: `bob-${uuidv4()}`, role: 'admin' };

		serverClient = await getTestClient(true);
		await serverClient.upsertUser(alice);
		await serverClient.upsertUser(bob);

		client = await getTestClientForUser(alice.id);
		bobClient = await getTestClientForUser(bob.id);

		channel = await client.channel('messaging', locationChan, {
			members: [alice.id, bob.id],
		});

		await channel.create();
	});

	after(async () => {
		await channel.delete();
	});

	describe('When Alice shares a static location', function () {
		it('should properly send the message and return it with a location attachment', async () => {
			let loc = {
				lat: 52.363811,
				lon: 4.88228,
				accuracy: 20,
			};

			let response = await channel.shareLocation(loc);
			equalLocationInAttachment(response.message, loc);
		});
	});

	describe('When Alice shares a live location', function () {
		before('start sharing live location', async () => {
			let loc = {
				lat: 52.363811,
				lon: 4.88228,
				accuracy: 20,
				live: true,
				expires_in_minutes: 15,
			};

			const response = await channel.shareLocation(loc);
			equalLocationInAttachment(response.message, loc);
		});

		after(
			"stop sharing live location and make sure updates can't be sent any longer",
			async () => {
				// Stop sharing
				let loc = {
					lat: 50.363811,
					lon: 2.88228,
					accuracy: 10,
					live: false,
				};

				const response = await client.stopLiveLocation(loc);
				expect(response.messages).to.have.lengthOf(1);
				equalLocationInAttachment(response.messages[0], loc);

				// Make sure location updates can't be sent any longer
				let error;
				try {
					await client.updateLiveLocation({
						lat: 49.363811,
						lon: 2.88228,
						accuracy: 12,
						live: false,
					});
				} catch (e) {
					error = e;
				}

				expect(error).to.not.be.undefined;
				expect(error.response).to.not.be.undefined;
				expect(error.response.status).to.equal(400);
				expect(error.response.data.message).to.equal(
					'UpdateLocation failed with error: "you currently don\'t have messages with live location attachments"',
				);
			},
		);

		it('can update a live location, even twice in a row', async () => {
			let loc = {
				lat: 51.92291,
				lon: 4.47059,
				accuracy: 20,
				live: true,
			};

			const response = await client.updateLiveLocation(loc);
			expect(response.messages).to.have.lengthOf(1);
			equalLocationInAttachment(response.messages[0], loc);

			let loc2 = {
				lat: 51.92291,
				lon: 4.47059,
				accuracy: 20,
				live: true,
			};

			const response2 = await client.updateLiveLocation(loc2);
			expect(response2.messages).to.have.lengthOf(1);
			equalLocationInAttachment(response2.messages[0], loc2);
		});

		it('should send a notification when a location is updated', async () => {
			let notifiedMessages = [];

			await channel.watch();
			channel.on('message.updated', (event) => {
				notifiedMessages.push(event.message.id);
			});

			let loc = {
				lat: 51.92291,
				lon: 4.47059,
				accuracy: 20,
				live: true,
			};

			const response = await client.updateLiveLocation(loc);
			expect(response.messages).to.have.lengthOf(1);
			equalLocationInAttachment(response.messages[0], loc);
			expect(notifiedMessages).to.contain(response.messages[0].id);

			let loc2 = {
				lat: 52.92291,
				lon: 42.47059,
				accuracy: 22,
				live: true,
			};

			const response2 = await client.updateLiveLocation(loc2);
			expect(response2.messages).to.have.lengthOf(1);
			equalLocationInAttachment(response2.messages[0], loc2);
			expect(notifiedMessages).to.contain(response2.messages[0].id);
		});

		it("can't update a live location with an invalid lon / lat / accuracy", async () => {
			let checkInputError = async (input) => {
				let error;

				try {
					await client.updateLiveLocation(input);
				} catch (e) {
					error = e;
				}

				expect(error).to.not.be.undefined;
				expect(error.response).to.not.be.undefined;
				expect(error.response.status).to.equal(400);
			};

			let locInvalidLat = {
				lat: 91,
				lon: 4.47059,
				accuracy: 20,
				live: true,
			};

			let locInvalidLon = {
				lat: 51.92291,
				lon: 181,
				accuracy: 20,
				live: true,
			};

			let locInvalidAccuracy = {
				lat: 51.92291,
				lon: 4.47059,
				accuracy: 101,
				live: true,
			};

			await checkInputError(locInvalidLat);
			await checkInputError(locInvalidLon);
			await checkInputError(locInvalidAccuracy);
		});

		it("can't update a live location without setting a user (i.e. server-side)", async () => {
			let error;

			try {
				await serverClient.updateLiveLocation({
					lat: 51.92291,
					lon: 4.47059,
					accuracy: 20,
					live: true,
				});
			} catch (e) {
				error = e;
			}

			expect(error).to.not.be.undefined;
			expect(error.response).to.not.be.undefined;
			expect(error.response.status).to.equal(400);
			expect(error.response.data.message).to.equal(
				'UpdateLocation failed with error: "no user set; updating the location of another user isn\'t possible"',
			);
		});

		it('stops sharing when expired', async () => {
			let locInstantlyExpired = {
				lat: 51.92291,
				lon: 51.0,
				accuracy: 20,
				live: true,
				expires_in_minutes: 0,
			};

			const msg = await channel.shareLocation(locInstantlyExpired);
			let locUpdate = {
				lat: 51.1,
				lon: 51.1,
				accuracy: 20,
				live: true,
			};

			await sleep(200);

			const updates = await client.updateLiveLocation(locUpdate);
			expect(updates.messages).to.not.be.undefined;
			expect(updates.messages.length).to.be.greaterThan(0);
			let updatedMsg = updates.messages.find((umsg) => umsg.id === msg.message.id);
			expect(updatedMsg).to.not.be.undefined;
			expect(updatedMsg.attachments.length).to.be.greaterThan(0);
			expect(updatedMsg.attachments[0].location.lon).to.equal(51.0);
			expect(updatedMsg.attachments[0].location.lat).to.equal(51.92291);
			expect(updatedMsg.attachments[0].location.live).to.be.false;
		});
	});
});
