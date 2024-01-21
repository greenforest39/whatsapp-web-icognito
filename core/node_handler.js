//
// Handling nodes
//

var NodeHandler = {};

NodeHandler.isSentNodeAllowed = function (node)
{
    var subNodes = [node];
    if (Array.isArray(node.content)) 
    {
        subNodes = subNodes.concat(node.content);
    }

    for (var i = 0; i < subNodes.length; i++)
    {
        var child = subNodes[i];

        var action = child.tag;
        var data = child.attrs;
        var shouldBlock = 
            (readConfirmationsHookEnabled && action === "read") ||
            (readConfirmationsHookEnabled && action == "receipt" && data["type"] == "read") ||
            (readConfirmationsHookEnabled && action == "receipt" && data["type"] == "read-self") ||
            (readConfirmationsHookEnabled && action == "receipt" && data["type"] === "played") ||
            (readConfirmationsHookEnabled && action == "received" && data["type"] === "played") ||

            (presenceUpdatesHookEnabled && action === "presence" && data["type"] === "available") ||
            (presenceUpdatesHookEnabled && action == "presence" && data["type"] == "composing") ||
            (presenceUpdatesHookEnabled && action == "chatstate" && child.content[0].tag == "composing");

        if (shouldBlock)
        {
            switch (action)
            {
                case "read":
                case "receipt":
                    var jid = data.jid ? data.jid : data.to;
                    jid = normalizeJID(jid.toString());

                    var isReadReceiptAllowed = exceptionsList.includes(jid);
                    if (isReadReceiptAllowed)
                    {
                        // this is the user trying to send out a read receipt.
                        console.log("WhatsIncongito: Allowing read receipt to " + jid);

                        // exceptions are one-time operation, so remove it from the list after some time
                        setTimeout(function() {
                            exceptionsList = exceptionsList.filter(i => i !== jid);
                        }, 2000);

                        return true;
                    }
                    else
                    {
                        // We do not allow sending this read receipt.
                        // invoke the callback and fake a failure response from server
                        document.dispatchEvent(new CustomEvent('onReadConfirmationBlocked', { detail: jid }));

                        if (action == "read" && wsHook.onMessage)
                        {
                            // TODO: in multi-device, not sending an error message back to the client results in a lot of repeated attempts.
                            var messageEvent = new MutableMessageEvent({ data: tag + ",{\"status\": 403}" });
                            wsHook.onMessage(messageEvent);
                        }

                    }
                    break;

                case "presence":
                    //var messageEvent = new MutableMessageEvent({ data: tag + ",{\"status\": 200}" });
                    //wsHook.onMessage(messageEvent);
                    break;
            }

            console.log("WhatsIncognito: --- Blocking " + action.toUpperCase() + " action! ---");
            console.log(node);

            return false;
        }
    }

    return true;
}

NodeHandler.interceptOutgoingNode = async function (node)
{
    var isAllowed = NodeHandler.isSentNodeAllowed(node);
    if (!isAllowed)
    {
        var manipulatedNode = deepClone(node);
        manipulatedNode.tag = "blocked_node";
        return [isAllowed, manipulatedNode];
    }

    //
    // Check for message nodes
    //
    if (node.tag == "message")
    {
        // manipulating a message node
        node = await NodeHandler.onOutgoingMessageNode(node);
    }

    return [true, node];
}

NodeHandler.onOutgoingMessageNode = async function (messageNode)
{
    var childNodes = messageNode.content;
    for (var i = 0; i < childNodes.length; i++)
    {
        var childNode = childNodes[i];

        try
        {
            if (childNode.tag == "enc")
            {
                childNodes[i] = await this.onSentEncNode(childNode, messageNode.attrs["to"].toString());
            }

            // list of devices to which a copy of the message is sent
            // say, in a message to a group, will contain copies of the message for each group participant.
            // in a private chat, will contain copies for the recipient and for the sender's real device
            if (childNode.tag == "participants")
            {
                var participants = childNode.content;
                for (var j = 0; j < participants.length; j++)
                {
                    var participant = participants[j];
                    if (participant.tag != "to") continue;
    
                    var encNode = participant.content[0];
                    if (encNode.tag == "enc")
                    {
                        var toJID = participant.attrs["jid"] ? participant.attrs["jid"]: participant.attrs["from"];

                        encNode = await this.onSentEncNode(encNode, toJID.toString());
                        participant.content[0] = encNode;
                        participants[j] = participant;
                    }
                }
            }
        }
        catch (exception)
        {
            console.error("WhatsIncognito: Allowing WA packet due to exception:");
            console.error(exception);
            console.error(exception.stack);
            return [true, messageNode]
        }
    }

    return messageNode;
}

NodeHandler.onSentEncNode = async function (encNode, remoteJid)
{
    if (remoteJid && isChatBlocked(remoteJid) && autoReceiptOnReplay)
    {
        // If the user replyed to a message from this JID,
        // It probably means we can send read receipts for it.

        // don't try to send receipts for multiple devices
        if (!remoteJid.includes(":"))
        {
            var chat = await getChatByJID(remoteJid);
            var data = { jid: chat.id, index: chat.lastReceivedKey.id, fromMe: chat.lastReceivedKey.fromMe, unreadCount: chat.unreadCount };
            setTimeout(function () { document.dispatchEvent(new CustomEvent('sendReadConfirmation', { detail: JSON.stringify(data) })); }, 600);
        }
    }

    // do message manipulation if needed
    //         ...
    var putBreakpointHere = 1;

    return encNode;
}

NodeHandler.interceptReceivedNode = async function (node)
{
    var isAllowed = true;

    // if this node does not contain a message, it's allowed
    if (node.tag != "message") return [true, node];

    var children = node.content;

    // scan for message nodes
    var nodes = [node];
    if (Array.isArray(children)) nodes = nodes.concat(children);

    var messageNodes = nodes.filter(node => node.tag == "message");

    for (var i = 0 ; i < messageNodes.length; i++)
    {
        var currentNode = messageNodes[i];
        var isMessageNodeAllowed = await NodeHandler.onReceivedMessageNode(currentNode, messageNodes);
        
        if (!isMessageNodeAllowed) isAllowed = false;
    }

    if (!isAllowed)
    {
        var manipulatedNode = deepClone(node);
        manipulatedNode.tag = "blocked_node";
        return [isAllowed, manipulatedNode];
    }

    return [isAllowed, node];
}

NodeHandler.onReceivedMessageNode = async function(currentNode, messageNodes)
{
    var isAllowed = true;

    var messageId = currentNode.attrs["id"];
    var remoteJid = currentNode.attrs["from"];
    var participant = currentNode.attrs["participant"];
    participant = participant ? participant : remoteJid;
    participant = participant.toString();

    // check for device type
    var looksLikePhone = participant.includes(":0@") || !participant.includes(":");
    var deviceType = looksLikePhone ? "phone" : "computer";
    deviceTypesPerMessage[messageId] = deviceType;

    var encNodes = await decryptE2EMessagesFromNode(currentNode);
    for (var message of encNodes)
    {
        isAllowed = NodeHandler.onReceivedE2EMessageNode(currentNode, message, encNodes, messageNodes);
        if (!isAllowed) break;
    }

    if (WAdebugMode && encNodes.length > 0)
    {
        console.log("Got messages:");
        console.log(encNodes);
    }

    return isAllowed;
}

NodeHandler.onReceivedE2EMessageNode = async function(currentNode, message, encNodes, messageNodes)
{
    var isAllowed = true;
    var remoteJid = null;
    var participant = null;
    
    if (currentNode.attrs != null)
    {
        messageId = currentNode.attrs["id"];

        remoteJid = currentNode.attrs["from"].toString();
        participant = currentNode.attrs["participant"];
        participant = participant ? participant : remoteJid;
    }

    var isRevokeMessage = NodeHandler.checkForMessageDeletionNode(message, messageId, remoteJid);
    await interceptViewOnceMessages(encNodes, messageId);

    if (!saveDeletedMsgsHookEnabled)
    {
        isAllowed = true;
    }
    else if (isRevokeMessage && encNodes.length == 1 && messageNodes.length == 1)
    {
        console.log("WhatsIncognito: --- Blocking message REVOKE action! ---");
        isAllowed = false;
    }
    else if (isRevokeMessage)
    {
        // TODO: edit the node to remove only the revoke messages
        console.log("WhatsIncognito: Not blocking node with revoked message because it will block other information.");
    }

    return isAllowed;
}

NodeHandler.checkForMessageDeletionNode = function(message, messageId, remoteJid)
{
    //
    // Check if this is a message deletion node
    //
    var messageRevokeValue = Message.ProtocolMessage.Type.REVOKE.value;
    if (message && message.protocolMessage && message.protocolMessage.type == messageRevokeValue)
    {
        var deletedMessageId = message.protocolMessage.key.id;
        if (saveDeletedMsgsHookEnabled)
        {
            onDeletionMessageBlocked(message, remoteJid, messageId, deletedMessageId);
        }

        return true;
    }

    return false;
}