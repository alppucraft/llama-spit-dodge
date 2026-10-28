# Llama Spit Dodge

## Run the game

Install [Node.js](https://nodejs.org/) once, then open Terminal in this folder and run:

```bash
npm install
npm start
```

Open `http://localhost:8000` in a browser.

Multiplayer parties can start with two players: one player is the llama and the other is the dodger.

For multiplayer on the same Wi-Fi, other players open `http://YOUR-COMPUTER-IP:8000`.
For internet multiplayer, deploy this folder to a Node.js host that supports WebSockets.

Parties and matches are held only in memory. Nothing is saved when the server stops.

## Deploy on Render

Push this folder to a GitHub repository. In Render, choose **New → Blueprint**, connect
that repository, and deploy the detected `render.yaml`. Keep the service at one
instance because active parties are stored in that instance's memory.
