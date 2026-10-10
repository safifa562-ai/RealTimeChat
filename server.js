
app.patch('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const id = intId(req.params.id);
    const message = String(req.body.message || '').trim();

    if (!id || !message) {
      return res.status(400).json({
        error: 'Message cannot be empty'
      });
    }

    if (message.length > 5000) {
      return res.status(400).json({
        error: 'Message is too long'
      });
    }

    const { data: oldMessage, error: findError } =
      await supabase
        .from('messages')
        .select('id, sender_id, receiver_id')
        .eq('id', id)
        .maybeSingle();

    if (findError) throw findError;

    if (!oldMessage) {
      return res.status(404).json({
        error: 'Message not found'
      });
    }

    if (Number(oldMessage.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({
        error: 'You can only edit your own messages'
      });
    }

    const { data: updated, error } = await supabase
      .from('messages')
      .update({
        message,
        edited_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    emitToUser(oldMessage.receiver_id, 'message-edited', updated);

    res.json(updated);
  } catch (error) {
    console.error('EDIT MESSAGE:', error);
    res.status(500).json({
      error: 'Could not edit message'
    });
  }
});
