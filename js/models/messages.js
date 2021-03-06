/*
 * vim: ts=4:sw=4:expandtab
 */
(function () {
    'use strict';
    window.Whisper = window.Whisper || {};

    var Message  = window.Whisper.Message = Backbone.Model.extend({
        database  : Whisper.Database,
        storeName : 'messages',
        initialize: function() {
            this.on('change:attachments', this.updateImageUrl);
            this.on('destroy', this.revokeImageUrl);
            this.on('change:expirationStartTimestamp', this.setToExpire);
            this.on('change:expireTimer', this.setToExpire);
            this.setToExpire();
        },
        defaults  : function() {
            return {
                timestamp: new Date().getTime(),
                attachments: []
            };
        },
        validate: function(attributes, options) {
            var required = ['conversationId', 'received_at', 'sent_at'];
            var missing = _.filter(required, function(attr) { return !attributes[attr]; });
            if (missing.length) {
                console.log("Message missing attributes: " + missing);
            }
        },
        isEndSession: function() {
            var flag = textsecure.protobuf.DataMessage.Flags.END_SESSION;
            return !!(this.get('flags') & flag);
        },
        isExpirationTimerUpdate: function() {
            var flag = textsecure.protobuf.DataMessage.Flags.EXPIRATION_TIMER_UPDATE;
            return !!(this.get('flags') & flag);
        },
        isGroupUpdate: function() {
            return !!(this.get('group_update'));
        },
        isIncoming: function() {
            return this.get('type') === 'incoming';
        },
        isUnread: function() {
            return !!this.get('unread');
        },
        getDescription: function() {
            if (this.isGroupUpdate()) {
                var group_update = this.get('group_update');
                if (group_update.left) {
                    return group_update.left + ' left the group.';
                }

                var messages = ['Updated the group.'];
                if (group_update.name) {
                    messages.push("Title is now '" + group_update.name + "'.");
                }
                if (group_update.joined) {
                    messages.push(group_update.joined.join(', ') + ' joined the group.');
                }

                return messages.join(' ');
            }
            if (this.isEndSession()) {
                return i18n('sessionEnded');
            }
            if (this.isIncoming() && this.hasKeyConflicts()) {
                return i18n('incomingKeyConflict');
            }
            if (this.isIncoming() && this.hasErrors()) {
                return i18n('incomingError');
            }
            return this.get('body');
        },
        isKeyChange: function() {
            return this.get('type') === 'keychange';
        },
        getNotificationText: function() {
            var description = this.getDescription();
            if (description) {
                return description;
            }
            if (this.get('attachments').length > 0) {
                return i18n('mediaMessage');
            }
            if (this.isExpirationTimerUpdate()) {
                return i18n('timerSetTo',
                    Whisper.ExpirationTimerOptions.getAbbreviated(
                      this.get('expirationTimerUpdate').expireTimer
                    )
                );
            }
            if (this.isKeyChange()) {
                var conversation = this.getModelForKeyChange();
                return i18n('keychanged', conversation.getTitle());
            }

            return '';
        },
        updateImageUrl: function() {
            this.revokeImageUrl();
            var attachment = this.get('attachments')[0];
            if (attachment) {
                var blob = new Blob([attachment.data], {
                    type: attachment.contentType
                });
                this.imageUrl = URL.createObjectURL(blob);
            } else {
                this.imageUrl = null;
            }
        },
        revokeImageUrl: function() {
            if (this.imageUrl) {
                URL.revokeObjectURL(this.imageUrl);
                this.imageUrl = null;
            }
        },
        getImageUrl: function() {
            if (this.imageUrl === undefined) {
                this.updateImageUrl();
            }
            return this.imageUrl;
        },
        getConversation: function() {
            return ConversationController.add({
                id: this.get('conversationId')
            });
        },
        getExpirationTimerUpdateSource: function() {
            if (this.isExpirationTimerUpdate()) {
              var conversationId = this.get('expirationTimerUpdate').source;
              var c = ConversationController.get(conversationId);
              if (!c) {
                  c = ConversationController.create({id: conversationId, type: 'private'});
                  c.fetch();
              }
              return c;
            }
        },
        getContact: function() {
            var conversationId = this.get('source');
            if (!this.isIncoming()) {
                conversationId = textsecure.storage.user.getNumber();
            }
            var c = ConversationController.get(conversationId);
            if (!c) {
                c = ConversationController.create({id: conversationId, type: 'private'});
                c.fetch();
            }
            return c;
        },
        getModelForKeyChange: function() {
            var id = this.get('key_changed');
            if (!this.modelForKeyChange) {
              var c = ConversationController.get(id);
              if (!c) {
                  c = ConversationController.create({ id: id, type: 'private' });
                  c.fetch();
              }
              this.modelForKeyChange = c;
            }
            return this.modelForKeyChange;
        },
        isOutgoing: function() {
            return this.get('type') === 'outgoing';
        },
        hasErrors: function() {
            return _.size(this.get('errors')) > 0;
        },
        hasKeyConflicts: function() {
            return _.any(this.get('errors'), function(e) {
                return (e.name === 'IncomingIdentityKeyError' ||
                        e.name === 'OutgoingIdentityKeyError');
            });
        },
        hasKeyConflict: function(number) {
            return _.any(this.get('errors'), function(e) {
                return (e.name === 'IncomingIdentityKeyError' ||
                        e.name === 'OutgoingIdentityKeyError') &&
                        e.number === number;
            });
        },
        getKeyConflict: function(number) {
            return _.find(this.get('errors'), function(e) {
                return (e.name === 'IncomingIdentityKeyError' ||
                        e.name === 'OutgoingIdentityKeyError') &&
                        e.number === number;
            });
        },

        send: function(promise) {
            this.trigger('pending');
            return promise.then(function(result) {
                var now = Date.now();
                this.trigger('done');
                if (result.dataMessage) {
                    this.set({dataMessage: result.dataMessage});
                }
                this.save({sent: true, expirationStartTimestamp: now});
                this.sendSyncMessage();
            }.bind(this)).catch(function(result) {
                var now = Date.now();
                this.trigger('done');
                if (result.dataMessage) {
                    this.set({dataMessage: result.dataMessage});
                }

                if (result instanceof Error) {
                    this.saveErrors(result);
                    if (result.name === 'SignedPreKeyRotationError') {
                        getAccountManager().rotateSignedPreKey();
                    }
                } else {
                    this.saveErrors(result.errors);
                    if (result.successfulNumbers.length > 0) {
                        this.set({sent: true, expirationStartTimestamp: now});
                        this.sendSyncMessage();
                    }
                }

            }.bind(this));
        },

        sendSyncMessage: function() {
            this.syncPromise = this.syncPromise || Promise.resolve();
            this.syncPromise = this.syncPromise.then(function() {
                var dataMessage = this.get('dataMessage');
                if (this.get('synced') || !dataMessage) {
                    return;
                }
                return textsecure.messaging.sendSyncMessage(
                    dataMessage, this.get('sent_at'), this.get('destination'), this.get('expirationStartTimestamp')
                ).then(function() {
                    this.save({synced: true, dataMessage: null});
                }.bind(this));
            }.bind(this));
        },

        saveErrors: function(errors) {
            if (!(errors instanceof Array)) {
                errors = [errors];
            }
            errors.forEach(function(e) {
                console.log(e);
                console.log(e.reason, e.stack);
            });
            errors = errors.map(function(e) {
                if (e.constructor === Error ||
                    e.constructor === TypeError ||
                    e.constructor === ReferenceError) {
                    return _.pick(e, 'name', 'message', 'code', 'number', 'reason');
                }
                return e;
            });
            errors = errors.concat(this.get('errors') || []);

            return this.save({errors : errors});
        },

        removeConflictFor: function(number) {
            var errors = _.reject(this.get('errors'), function(e) {
                return e.number === number &&
                    (e.name === 'IncomingIdentityKeyError' ||
                     e.name === 'OutgoingIdentityKeyError');
            });
            this.set({errors: errors});
        },

        hasNetworkError: function(number) {
            var error = _.find(this.get('errors'), function(e) {
                return (e.name === 'MessageError' ||
                        e.name === 'OutgoingMessageError' ||
                        e.name === 'SendMessageNetworkError' ||
                        e.name === 'SignedPreKeyRotationError');
            });
            return !!error;
        },
        removeOutgoingErrors: function(number) {
            var errors = _.partition(this.get('errors'), function(e) {
                return e.number === number &&
                    (e.name === 'MessageError' ||
                     e.name === 'OutgoingMessageError' ||
                     e.name === 'SendMessageNetworkError' ||
                     e.name === 'SignedPreKeyRotationError');
            });
            this.set({errors: errors[1]});
            return errors[0][0];
        },
        isReplayableError: function(e) {
            return (e.name === 'MessageError' ||
                    e.name === 'OutgoingMessageError' ||
                    e.name === 'SendMessageNetworkError' ||
                    e.name === 'SignedPreKeyRotationError');
        },

        resend: function(number) {
            var error = this.removeOutgoingErrors(number);
            if (error) {
                var promise = new textsecure.ReplayableError(error).replay();
                this.send(promise);
            }
        },

        resolveConflict: function(number) {
            var error = this.getKeyConflict(number);
            if (error) {
                this.removeConflictFor(number);
                var promise = new textsecure.ReplayableError(error).replay();
                if (this.isIncoming()) {
                    promise = promise.then(function(dataMessage) {
                        this.removeConflictFor(number);
                        this.handleDataMessage(dataMessage);
                    }.bind(this));
                } else {
                    promise = this.send(promise).then(function() {
                        this.removeConflictFor(number);
                        this.save();
                    }.bind(this));
                }
                promise.catch(function(e) {
                    this.removeConflictFor(number);
                    this.saveErrors(e);
                }.bind(this));

                return promise;
            }
        },
        handleDataMessage: function(dataMessage) {
            // This function can be called from the background script on an
            // incoming message or from the frontend after the user accepts an
            // identity key change.
            var message = this;
            var source = message.get('source');
            var type = message.get('type');
            var timestamp = message.get('sent_at');
            var conversationId = message.get('conversationId');
            if (dataMessage.group) {
                conversationId = dataMessage.group.id;
            }
            var conversation = ConversationController.create({id: conversationId});
            conversation.queueJob(function() {
                return new Promise(function(resolve) {
                    conversation.fetch().always(function() {
                        var now = new Date().getTime();
                        var attributes = { type: 'private' };
                        if (dataMessage.group) {
                            var group_update = null;
                            attributes = {
                                type: 'group',
                                groupId: dataMessage.group.id,
                            };
                            if (dataMessage.group.type === textsecure.protobuf.GroupContext.Type.UPDATE) {
                                attributes = {
                                    type       : 'group',
                                    groupId    : dataMessage.group.id,
                                    name       : dataMessage.group.name,
                                    avatar     : dataMessage.group.avatar,
                                    members    : _.union(dataMessage.group.members, conversation.get('members')),
                                };
                                group_update = conversation.changedAttributes(_.pick(dataMessage.group, 'name', 'avatar')) || {};
                                var difference = _.difference(attributes.members, conversation.get('members'));
                                if (difference.length > 0) {
                                    group_update.joined = difference;
                                }
                            }
                            else if (dataMessage.group.type === textsecure.protobuf.GroupContext.Type.QUIT) {
                                if (source == textsecure.storage.user.getNumber()) {
                                    attributes.left = true;
                                    group_update = { left: "You" };
                                } else {
                                    group_update = { left: source };
                                }
                                attributes.members = _.without(conversation.get('members'), source);
                            }

                            if (group_update !== null) {
                                message.set({group_update: group_update});
                            }
                        }
                        message.set({
                            body           : dataMessage.body,
                            conversationId : conversation.id,
                            attachments    : dataMessage.attachments,
                            decrypted_at   : now,
                            flags          : dataMessage.flags,
                            errors         : []
                        });
                        if (type === 'outgoing') {
                            var receipts = Whisper.DeliveryReceipts.forMessage(conversation, message);
                            receipts.forEach(function(receipt) {
                                message.set({
                                    delivered: (message.get('delivered') || 0) + 1
                                });
                            });
                        }
                        attributes.active_at = now;
                        conversation.set(attributes);

                        if (message.isExpirationTimerUpdate()) {
                            message.set({
                                expirationTimerUpdate: {
                                    source      : source,
                                    expireTimer : dataMessage.expireTimer
                                }
                            });
                            conversation.set({expireTimer: dataMessage.expireTimer});
                        } else if (dataMessage.expireTimer) {
                            message.set({expireTimer: dataMessage.expireTimer});
                        }

                        if (!message.isEndSession() && !message.isGroupUpdate()) {
                            if (dataMessage.expireTimer) {
                                if (dataMessage.expireTimer !== conversation.get('expireTimer')) {
                                  conversation.updateExpirationTimer(
                                      dataMessage.expireTimer, source,
                                      message.get('received_at'));
                                }
                            } else if (conversation.get('expireTimer')) {
                                conversation.updateExpirationTimer(null, source,
                                    message.get('received_at'));
                            }
                        }
                        if (type === 'incoming') {
                            var readReceipt = Whisper.ReadReceipts.forMessage(message);
                            if (readReceipt) {
                                if (message.get('expireTimer') && !message.get('expirationStartTimestamp')) {
                                    message.set('expirationStartTimestamp', readReceipt.get('read_at'));
                                }
                            }
                            if (readReceipt || message.isExpirationTimerUpdate()) {
                                message.unset('unread');
                            } else {
                                conversation.set('unreadCount', conversation.get('unreadCount') + 1);
                            }
                        }

                        var conversation_timestamp = conversation.get('timestamp');
                        if (!conversation_timestamp || message.get('sent_at') > conversation_timestamp) {
                            conversation.set({
                                lastMessage : message.getNotificationText(),
                                timestamp: message.get('sent_at')
                            });
                        }
                        message.save().then(function() {
                            conversation.save().then(function() {
                                conversation.trigger('newmessage', message);
                                if (message.get('unread')) {
                                    conversation.notify(message);
                                }
                                resolve();
                            });
                        });
                    });
                });
            });
        },
        markRead: function(read_at) {
            this.unset('unread');
            if (this.get('expireTimer') && !this.get('expirationStartTimestamp')) {
                this.set('expirationStartTimestamp', read_at || Date.now());
            }
            Whisper.Notifications.remove(Whisper.Notifications.where({
                messageId: this.id
            }));
            return this.save();
        },
        isExpiring: function() {
            return this.get('expireTimer') && this.get('expirationStartTimestamp');
        },
        msTilExpire: function() {
              if (!this.isExpiring()) {
                return Infinity;
              }
              var now = Date.now();
              var start = this.get('expirationStartTimestamp');
              var delta = this.get('expireTimer') * 1000;
              var ms_from_now = start + delta - now;
              if (ms_from_now < 0) {
                  ms_from_now = 0;
              }
              return ms_from_now;
        },
        setToExpire: function() {
            if (this.isExpiring() && !this.get('expires_at')) {
                var start = this.get('expirationStartTimestamp');
                var delta = this.get('expireTimer') * 1000;
                var expires_at = start + delta;
                this.save('expires_at', expires_at);
                Whisper.ExpiringMessagesListener.update();
                console.log('message', this.get('sent_at'), 'expires at', expires_at);
            }
        }

    });

    Whisper.MessageCollection = Backbone.Collection.extend({
        model      : Message,
        database   : Whisper.Database,
        storeName  : 'messages',
        comparator : 'received_at',
        initialize : function(models, options) {
            if (options) {
                this.conversation = options.conversation;
            }
        },
        destroyAll : function () {
            return Promise.all(this.models.map(function(m) {
                return new Promise(function(resolve, reject) {
                    m.destroy().then(resolve).fail(reject);
                });
            }));
        },

        fetchSentAt: function(timestamp) {
            return new Promise(function(resolve) {
                return this.fetch({
                    index: {
                        // 'receipt' index on sent_at
                        name: 'receipt',
                        only: timestamp
                    }
                }).always(resolve);
            }.bind(this));
        },

        getLoadedUnreadCount: function() {
            return this.models.reduce(function(total, model) {
                var count = model.get('unread');
                if (count === undefined) {
                    count = 0;
                }
                return total + count;
            }, 0);
        },

        fetchConversation: function(conversationId, limit, unreadCount) {
            if (typeof limit !== 'number') {
                limit = 100;
            }
            if (typeof unreadCount !== 'number') {
                unreadCount = 0;
            }
            return new Promise(function(resolve) {
                var upper;
                if (this.length === 0) {
                    // fetch the most recent messages first
                    upper = Number.MAX_VALUE;
                } else {
                    // not our first rodeo, fetch older messages.
                    upper = this.at(0).get('received_at');
                }
                var options = {remove: false, limit: limit};
                options.index = {
                    // 'conversation' index on [conversationId, received_at]
                    name  : 'conversation',
                    lower : [conversationId],
                    upper : [conversationId, upper],
                    order : 'desc'
                    // SELECT messages WHERE conversationId = this.id ORDER
                    // received_at DESC
                };
                this.fetch(options).then(resolve);
            }.bind(this)).then(function() {
                var loadedUnread = this.getLoadedUnreadCount();
                if (loadedUnread < unreadCount) {
                    return this.fetchConversation(conversationId, limit, unreadCount);
                }
            }.bind(this));
        },

        fetchNextExpiring: function() {
            this.fetch({ index: { name: 'expires_at' }, limit: 1 });
        },

        fetchExpired: function() {
            console.log('loading expired messages');
            this.fetch({
                conditions: { expires_at: { $lte: Date.now() } },
                addIndividually: true
            });
        },

        hasKeyConflicts: function() {
            return this.any(function(m) { return m.hasKeyConflicts(); });
        }
    });
})();
