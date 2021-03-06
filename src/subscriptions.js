import express from "express";
import config from "config";
import bodyParser from "body-parser";
import crypto from "crypto";
import axios from "axios";

import logger from "./logger";

const app = express();
app.use(
  bodyParser.json({
    verify: (req, res, buf, encoding) => {
      if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || "utf8");
      }
    }
  })
);
app.use(bodyParser.urlencoded({ extended: true }));

const MESSAGE_FIELD_MAP = {
  messages: "message",
  message_deliveries: "delivery",
  messaging_optins: "optin",
  messaging_postbacks: "postback",
  message_reads: "read"
};

// Validate request
// Should either be authorization or webhook data with signature
const validateRequest = (req, res, next) => {
  if (req.query["hub.mode"] == "subscribe" || req.headers["x-hub-signature"]) {
    next();
  } else {
    logger.warn("Invalid request, returning 200 anyway");
    res.status(200).send("pong");
  }
};

// Authorize Facebook
const authorizeFacebook = (req, res, next) => {
  if (req.query["hub.mode"] == "subscribe") {
    const valid = req.query["hub.verify_token"] == app.get("fbVerifyToken");
    if (valid) {
      logger.info("Authorizing subscription through hub token");
      res.status(200).send(req.query["hub.challenge"]);
    } else {
      logger.warn("Unauthorized authorization request");
      res.status(400).send("Invalid token");
    }
  } else {
    next();
  }
};

// Hub signature verification
const verifyHubSignature = (req, res, next) => {
  const facebookConfig = config.get("facebook");
  const signature = req.headers["x-hub-signature"];
  if (signature !== undefined) {
    const hmac = crypto.createHmac("sha1", facebookConfig.clientSecret);
    hmac.update(req.rawBody);
    const expectedSignature = "sha1=" + hmac.digest("hex");
    if (expectedSignature !== signature) {
      logger.warn("Invalid signature from hub challenge");
      res.status(400).send("Invalid signature");
    } else {
      next();
    }
  } else {
    next();
  }
};

const Push = function(name, service, facebookId, item, time) {
  return {
    ddp: () => {
      const clients = app.get("ddpClients");
      const client = clients[name];
      return new Promise((resolve, reject) => {
        client.call(
          service.methodName,
          [
            {
              token: service.token,
              facebookAccountId: facebookId,
              data: getBody(facebookId, time, item)
            }
          ],
          (err, res) => {
            if (!err) {
              resolve(res);
            } else {
              if (service.test) {
                logger.warn(`${name} test service errored`);
                console.log(err);
                resolve();
              } else {
                reject(err);
              }
            }
          }
        );
      });
    },
    http: () => {
      return new Promise((resolve, reject) => {
        let url = service.url;
        if (service.token) {
          url += `?token=${service.token}`;
        }
        const body = getBody(facebookId, time, item);
        axios
          .post(url, body)
          .then(res => {
            resolve(res);
          })
          .catch(err => {
            if (service.test) {
              logger.warn(`${name} test service errored`);
              console.log(err);
              resolve();
            } else {
              reject(err);
            }
          });
      });
    }
  };
};

const validateFields = (serviceFields, item) => {
  if (item.field) {
    // FEED validation
    return serviceFields.indexOf(item.field) !== -1;
  } else if (item.sender) {
    // Message validation
    let fields = serviceFields.map(field => MESSAGE_FIELD_MAP[field]);
    let valid = false;
    Object.keys(item).forEach(key => {
      if (fields.indexOf(key) !== -1) valid = true;
    });
    return valid;
  }
  return false;
};

const getBody = (facebookId, time, item) => {
  let body = {
    object: "page",
    entry: [
      {
        time,
        id: facebookId
      }
    ]
  };
  if (item.field) {
    body.entry[0].changes = [item];
  }
  if (item.sender) {
    body.entry[0].messaging = [item];
  }
  return body;
};

const pushItem = (facebookId, item, time) => {
  const services = config.get("services");
  let promises = [];
  for (const serviceName in services) {
    const service = services[serviceName];
    if (
      !service.fields ||
      !service.fields.length ||
      validateFields(service.fields, item)
    ) {
      promises.push(
        new Promise((resolve, reject) => {
          const push = Push(serviceName, service, facebookId, item, time);
          if (push[service.type]) {
            push[service.type]()
              .then(res => {
                resolve(res);
              })
              .catch(err => {
                reject(err);
              });
          } else {
            reject("Service type not supported");
          }
        })
      );
    }
  }
  return Promise.all(promises);
};

// Handling subscription data
app.use(
  "/",
  validateRequest,
  authorizeFacebook,
  verifyHubSignature,
  (req, res) => {
    let body = req.body;
    if (Buffer.isBuffer(req.body)) body = JSON.parse(req.body.toString());
    if (body.object == "page") {
      logger.info(
        `Receiving ${body.entry.length} entries from Facebook subscription`
      );
      let errors = [];
      let promises = [];
      body.entry.forEach(entry => {
        const facebookId = entry.id;
        if (entry.changes) {
          entry.changes.forEach(async item => {
            promises.push(pushItem(facebookId, item, entry.time));
          });
        } else if (entry.messaging) {
          entry.messaging.forEach(async item => {
            promises.push(pushItem(facebookId, item, entry.time));
          });
        }
      });
      Promise.all(promises)
        .then(() => {
          logger.info("Succesfully processed webhook updates");
          res.sendStatus(200);
        })
        .catch(err => {
          console.log(err);
          logger.error("Error processing webhook data");
          res.status(500).send(err);
        });
    } else {
      res.sendStatus(400);
    }
  }
);

export default app;
