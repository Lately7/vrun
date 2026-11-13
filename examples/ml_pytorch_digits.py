# vrun — practice: a small neural network in PyTorch (handwritten digits).
# Run the cells in order with Ctrl+Alt+C. In the vrun panel:
#   * X_img has an "image" button: look at the digits you train on;
#   * net shows its parameter count, opt its learning rate;
#   * losses / val_accs have a "chart" button: the training curves.

# %% 1. Data: 1797 digits of 8 x 8 pixels (bundled, no download)
import numpy as np
import torch
from sklearn.datasets import load_digits
from sklearn.model_selection import train_test_split

torch.manual_seed(0)
digits = load_digits()
X_img = torch.tensor(digits.images, dtype=torch.float32) / 16.0   # (1797, 8, 8)
y = torch.tensor(digits.target)
X_train, X_val, y_train, y_val = train_test_split(X_img.reshape(len(X_img), -1), y, test_size=0.2, random_state=0)

# %% 2. Model and optimizer
from torch import nn

net = nn.Sequential(nn.Linear(64, 64), nn.ReLU(), nn.Linear(64, 10))
opt = torch.optim.Adam(net.parameters(), lr=1e-2)
loss_fn = nn.CrossEntropyLoss()
losses, val_accs = [], []

# %% 3. Train — run this cell again to train more (the weights carry over)
from tqdm import tqdm

for epoch in tqdm(range(30), desc="epochs"):
    net.train()
    opt.zero_grad()
    loss = loss_fn(net(X_train), y_train)
    loss.backward()
    opt.step()
    losses.append(loss.item())        # .item(): a number, not a tensor with its graph
    net.eval()
    with torch.no_grad():
        val_accs.append((net(X_val).argmax(1) == y_val).float().mean().item())
print(f"loss {losses[-1]:.3f}   validation accuracy {val_accs[-1]:.3f}")

# %% [live] 4. Look at mistakes — Live Mode re-runs this as you edit it
with torch.no_grad():
    pred = net(X_val).argmax(1)
wrong = (pred != y_val).nonzero().flatten()
mistakes = X_val[wrong].reshape(-1, 8, 8)    # "image" in Variables shows them
pred[wrong][:10], y_val[wrong][:10]

# %% 5. Exercise: add a hidden layer, change lr, or train for more epochs.
# Re-run cell 2 to start from fresh weights, then cell 3.
