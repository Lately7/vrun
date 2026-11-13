# vrun — practice: the same digits task with Keras (TensorFlow or Keras 3).
# Run the cells in order with Ctrl+Alt+C. The fit progress bar redraws in
# place in the Output tab; `history` has a "chart" button in Variables.

# %% 1. Data (bundled with scikit-learn, no download)
import numpy as np
from sklearn.datasets import load_digits
from sklearn.model_selection import train_test_split

digits = load_digits()
X = digits.images.astype("float32") / 16.0          # (1797, 8, 8): "image" in Variables
y = digits.target
X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=0)

# %% 2. Model
import keras

keras.utils.set_random_seed(0)
model = keras.Sequential([
    keras.Input(shape=(8, 8)),
    keras.layers.Flatten(),
    keras.layers.Dense(64, activation="relu"),
    keras.layers.Dense(10, activation="softmax"),
])
model.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
model.summary()

# %% 3. Train (re-running continues from the current weights; re-run cell 2 to restart)
history = model.fit(X_train, y_train, epochs=15, batch_size=32, validation_data=(X_val, y_val))

# %% [live] 4. Evaluate
val_loss, val_acc = model.evaluate(X_val, y_val, verbose=0)
best_epoch = int(np.argmin(history.history["val_loss"])) + 1
val_acc, best_epoch

# %% 5. Exercise: add keras.layers.Dropout(0.2), or an EarlyStopping callback:
# keras.callbacks.EarlyStopping(patience=3, restore_best_weights=True)
