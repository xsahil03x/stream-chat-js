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

## Permission settings

## queryChannels filters

## Rate limits
