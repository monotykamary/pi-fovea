def publish_user_changed(broker, user):
    computed_channel = "users.computed"
    broker.publish(computed_channel, user)
    broker.publish("users.changed", user)
