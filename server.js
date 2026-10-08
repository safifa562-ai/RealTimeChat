socket.on("private-message", async (data) => {
  try {
    const senderId = Number(data.senderId);
    const receiverId = Number(data.receiverId);

    if (!senderId || !receiverId) return;

    // Security: sender must be logged-in socket user
    if (senderId !== Number(socket.userId)) {
      return;
    }

    const messageType =
      data.messageType === "file"
        ? "file"
        : "text";

    const message =
      String(data.message || "").trim();

    if (messageType === "text" && !message) {
      return;
    }

    const insertData = {
      sender_id: senderId,
      receiver_id: receiverId,
      message: message || null,
      message_type: messageType,
      file_name:
        data.fileName || null,
      file_url:
        data.fileUrl || null,
      file_size:
        data.fileSize
          ? Number(data.fileSize)
          : null
    };

    const {
      data: saved,
      error
    } = await supabase
      .from("messages")
      .insert(insertData)
      .select("*")
      .single();

    if (error) {
      console.error(
        "MESSAGE DB ERROR:",
        error
      );

      socket.emit("message-error", {
        error: "Message could not be saved"
      });

      return;
    }

    // Send to receiver
    const receiver =
      onlineUsers.get(
        String(receiverId)
      );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "private-message",
        saved
      );
    }

    // Send back to sender
    socket.emit(
      "private-message",
      saved
    );

  } catch (error) {
    console.error(
      "PRIVATE MESSAGE ERROR:",
      error
    );

    socket.emit("message-error", {
      error: "Message failed"
    });
  }
});
