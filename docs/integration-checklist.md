# Checklist for stream integration

## websocket connection

When you initiate the client, you would generally do it this way:

```js
const chatClient = new StreamChat('ap_key');

await chatClient.setUser({ id: 'vishal' });
```

In example above, `chatClient.setUser(...)` actually establishes websocket connection with backend, over which your chatClient receives updates from backend.

There are few things to keep in mind regarding these websocket connections:

### Single connection per user

```js
const chatClient1 = new StreamChat('ap_key');
await chatClient1.setUser({ id: 'vishal' });

const chatClient2 = new StreamChat('ap_key');
await chatClient2.setUser({ id: 'vishal' });
```

In above code, you have actually created 2 different active websocket connections. Generally you should only have 1 websocket connection per chat instance per user. If you need access to `chatClient` at multiple places in single page (application), then its better to cache the `chatClient` in some service or higher order component and use that cached instance everywhere.

**As a quick check, we strongly recommend you to do global search over codebase for `setUser`, and make sure you don't make more than one call to `setUser` function on single page.**

### Call `chatClient.disconnect` to avoid orphan connections

If for some reason, you decide to make multiple calls to setUser on frontend or server side, its important to do cleanup when chatClient is not needed anymore. Some typical examples of bad integration are as following:

#### Node Example

```js
// ❌ This is super wrong, because following code will create 10 websocket connections.
for (let i = 0; i < 10; i++) {
    const chatClient = new StreamChat('api_key', 'secret');
    const result = await chatClient.setUser({ id: `vishal-${i}` });

    console.log(result.me.unread_channels);
}

// ✅ You should disconnect once you are done with chatClient
for (let i = 0; i < 10; i++) {
    const chatClient = new StreamChat('api_key', 'secret');
    const result = await chatClient.setUser({ id: `vishal-${i}` });

    console.log(result.me.unread_channels);
    await chatClient.disconnect();
}
```

#### React useEffect example

```js

// ❌ This is super wrong, because following code will keep on creating new websocket connection
// everytime useEffect hook gets executed (on chances to `currentUser`)
const [ chatClient, setChatClient ] = useState(null);
const [ currentUser, setCurrentUser ] = useState(null);
useEffect(() => {
    const initChat = async () => {
        const client = new StreamChat('api_key', 'secret');
        const result = await chatClient.setUser({ id: currentUser });
        setChatClient(client);
    }

    initChat();
    // .. and some more code here
}, [currentUser])


// ✅ You should disconnect once you are done with chatClient
const [ chatClient, setChatClient ] = useState(null);
const [ currentUser, setCurrentUser ] = useState(null);
useEffect(() => {
    const initChat = async () => {
        const client = new StreamChat('api_key', 'secret');
        const result = await chatClient.setUser({ id: currentUser });
        setChatClient(client);
    }

    initChat();
    // .. and some more code here

    return () => {
        chatClient.disconnect();
    }
}, [currentUser])

```

## Application Settings
There are two main areas of settings where mistakes can be made - permission settings, and channel feature settings. These can be changed through the Stream Dashboard.

### Permission settings
Under the settings for your application, be sure to make sure Permission Checks are not disabled. Stream is built with a complex yet flexible permission system that checks if a user is able to perform certain actions based on their user role (think channel member vs moderator). Disabling this permission layer opens your application up to vulnerabilities, such as a user modifying another user's messages. 

### Channel Settings
Within each channel type (yes, these settings are configurable on a channel type basis), you are able to toggle on certain events. This translates to the different events that are transmitted through the websocket connections, and although increasing the featureset of a channel, also increase the load on the client.

**So, for your livestreaming type channels, you will probably want to disable features such as uploads, read receipts, and typing indicators.**

## queryChannels filters
A Channel list in an application can often form the backbone of the chat experience, and be one of the first views that a user sees upon opening a chat experience. Although not entirely pertinent for a livestream situation, it is important to run a filter that is optimal if it is needed. 

*exampels of slow queries*

## Rate limits
Rate limits are in place to protect our API from misuse, to protect the other applications in a shared infrastructure environment, and to protect the user from integration errors. Although rate limits can be flexible on Enterprise plans, it is important to structure your application within the limits of the rate limits are described [here] (https://getstream.io/chat/docs/rate_limits/?language=js). Some important points

- Rate limits are application wide and per user. Application rate limits refer to the number of API requests a single application can make, whereas user rate limits are the number of API calls a single user can make (60/min/endpoint).
- Many of our endpoints can be accessed using batch methods, for example, adding members to a channel. This rate limit is relatively low, owing to the heavy work the API must to do update the channel for all memebers. Alleviate some of this by adding or removing up to 100 members are once. 
- Cache API responses if necessary and only query when necessary.

## Adding Users to the Application and Channels 
A common bottleneck for API calls is both adding users to the application and adding users to channels. If possible, it can be beneficial to add users in batches before events start. 

## Excessive API calls to /Channel
There are a number of ways with the Stream Chat API to hit the /channel endpoint, some of which will often be unecessary 

``` js

// queryChannels hits the /channels endpoint with a query

// channel.create
// channel.watch
// channel.query

// use querychannels to also do .watch?

```
